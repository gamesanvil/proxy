const http = require('http');
const httpProxy = require('http-proxy');
const dns = require('dns').promises;
const axios = require('axios');
const url = require('url');

const proxy = httpProxy.createProxyServer({
    ws: true,
    changeOrigin: true,
    autoRewrite: true,
    secure: false,
});

const COLYSEUS_INTERNAL_DNS = process.env.COLYSEUS_INTERNAL_URL; // например: colyseus.up.railway.internal
const COLYSEUS_PORT = process.env.COLYSEUS_PORT || 2567;
const PROXY_PORT = process.env.PORT || 80;

const POD_CACHE = new Map();

const log = console.log.bind(console);
const error = console.error.bind(console);

async function discoverAndGetIp(podId) {
    const cached = POD_CACHE.get(podId);
    if (cached && cached.expiresAt > Date.now()) {
        log(`[CACHE HIT] podId=${podId} → ${cached.ip}`);
        return cached.ip;
    }

    log(`[CACHE MISS] Discovering IP for podId=${podId}`);

    let ips = [];
    try {
        const [ipv4, ipv6] = await Promise.all([
            dns.resolve4(COLYSEUS_INTERNAL_DNS).catch(() => []),
            dns.resolve6(COLYSEUS_INTERNAL_DNS).catch(() => []),
        ]);
        ips = [...new Set([...ipv4, ...ipv6])];
        log(`[DNS] Resolved ${ips.length} IP(s): ${ips.join(', ')}`);
    } catch (err) {
        error(`[DNS ERROR] ${err.message}`);
        return null;
    }

    if (ips.length === 0) {
        error(`[DISCOVERY] No IPs resolved for ${COLYSEUS_INTERNAL_DNS}`);
        return null;
    }

    const results = await Promise.allSettled(
        ips.map(async (ip) => {
            const target = `http://${ip.includes(':') ? `[${ip}]` : ip}:${COLYSEUS_PORT}/podid`;
            try {
                const res = await axios.get(target, { timeout: 3000 });
                return { ip, podId: res.data.podId?.toString() };
            } catch (e) {
                log(`[HEALTHCHECK] ${ip} → unreachable or no podId`);
                return null;
            }
        })
    );

    for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.podId === podId) {
            const ip = result.value.ip;
            POD_CACHE.set(podId, { ip, expiresAt: Date.now() + 18_000 }); // 18 сек
            log(`[DISCOVERED] podId=${podId} → ${ip} (cached 18s)`);
            return ip;
        }
    }

    error(`[NOT FOUND] podId=${podId} не найден среди живых реплик`);
    return null;
}

async function checkAllPodsHavePodId() {
    let ips = [];
    try {
        const [ipv4, ipv6] = await Promise.all([
            dns.resolve4(COLYSEUS_INTERNAL_DNS).catch(() => []),
            dns.resolve6(COLYSEUS_INTERNAL_DNS).catch(() => []),
        ]);
        ips = [...new Set([...ipv4, ...ipv6])];
        log(`[HEALTH] Resolved IPs: ${ips.join(', ')}`);
    } catch (err) {
        error(`[HEALTH DNS ERROR] ${err.message}`);
        return { ok: false, reason: 'dns_error' };
    }

    if (!ips.length) {
        return { ok: false, reason: 'no_ips' };
    }

    const results = await Promise.allSettled(
        ips.map(async (ip) => {
            const target = `http://${ip.includes(':') ? `[${ip}]` : ip}:${COLYSEUS_PORT}/podid`;
            const res = await axios.get(target, { timeout: 2000 });
            const podId = res.data?.podId?.toString();

            if (!podId) {
                throw new Error('podId missing');
            }

            return { ip, podId };
        })
    );

    const failed = results.filter(r => r.status === 'rejected');
    const success = results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

    if (failed.length > 0) {
        error(`[HEALTH FAIL] ${failed.length}/${ips.length} pods unhealthy`);
        return {
            ok: false,
            reason: 'some_pods_unhealthy',
            success,
        };
    }

    return {
        ok: true,
        pods: success,
    };
}



const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        const result = await checkAllPodsHavePodId();

        if (result.ok) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                pods: result.pods,
            }));
        } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'unhealthy',
                reason: result.reason,
                pods: result.success || [],
            }));
        }
        return;
    }

    const start = Date.now();
    const parsed = url.parse(req.url);
    const pathParts = parsed.pathname?.split('/').filter(Boolean) || [];
    const podId = pathParts[0]; // первый сегмент — это podId

    log(`[HTTP] ${req.method} ${req.url} → podId=${podId || '(none)'}`);

    if (!podId) {
        res.writeHead(400);
        res.end('Bad Request: podId missing in path');
        return;
    }

    const targetIp = await discoverAndGetIp(podId);
    if (!targetIp) {
        res.writeHead(504);
        res.end('Pod not found or all replicas unhealthy');
        log(`[FAIL] 504 — podId=${podId} not reachable`);
        return;
    }

    const target = `http://${targetIp.includes(':') ? `[${targetIp}]` : targetIp}:${COLYSEUS_PORT}`;

    proxy.web(req, res, { target }, (err) => {
        if (err) {
            error(`[PROXY ERROR] HTTP ${req.url} → ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
            }
        } else {
            log(`[OK] HTTP ${req.url} → ${target} (${Date.now() - start}ms)`);
        }
    });
});

server.on('upgrade', async (req, socket, head) => {
    const start = Date.now();
    const parsed = url.parse(req.url);
    const pathParts = parsed.pathname?.split('/').filter(Boolean) || [];
    const podId = pathParts[0];

    log(`[WS UPGRADE] ${req.url} → podId=${podId || '(none)'}`);

    if (!podId) {
        log(`[WS REJECT] No podId`);
        socket.destroy();
        return;
    }

    const targetIp = await discoverAndGetIp(podId);
    if (!targetIp) {
        log(`[WS REJECT] podId=${podId} not found`);
        socket.destroy();
        return;
    }

    const target = `ws://${targetIp.includes(':') ? `[${targetIp}]` : targetIp}:${COLYSEUS_PORT}`;

    req.headers['host'] = targetIp.includes(':') ? `[${targetIp}]:${COLYSEUS_PORT}` : `${targetIp}:${COLYSEUS_PORT}`;

    proxy.ws(req, socket, head, { target }, (err) => {
        if (err) {
            error(`[WS PROXY ERROR] ${req.url} → ${err.message}`);
        } else {
            log(`[WS OK] Connected to ${target} (${Date.now() - start}ms)`);
        }
    });
});

proxy.on('error', (err, req, res) => {
    error(`[PROXY GLOBAL ERROR] ${err.message}`);
    if (res && !res.headersSent) {
        if (res.writeHead) res.writeHead(502);
        res.end('Proxy error');
    }
});

server.listen(PROXY_PORT, '::', () => {
    log(`Proxy server listening on port ${PROXY_PORT}`);
    log(`Target service DNS: ${COLYSEUS_INTERNAL_DNS}`);
    log(`Target port: ${COLYSEUS_PORT}`);
});