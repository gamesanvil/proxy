const http = require('http');
const httpProxy = require('http-proxy');
const dns = require('dns').promises;
const axios = require('axios');
const url = require('url');

const proxy = httpProxy.createProxyServer({ ws: true });

// Кэш только на 15–20 секунд (очень короткий TTL)
const POD_CACHE = new Map(); // podId → { ip, expiresAt }
const COLYSEUS_URL = process.env.COLYSEUS_INTERNAL_URL;

async function getIpForPod(podId) {
    const cached = POD_CACHE.get(podId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.ip;
    }

    const ips4 = await dns.resolve4(COLYSEUS_URL).catch(() => []);
    const ips6 = await dns.resolve6(COLYSEUS_URL).catch(() => []);
    const allIps = [...new Set([...ips4, ...ips6])];

    const results = await Promise.allSettled(
        allIps.map(ip =>
            axios.get(`http://${ip}:${process.env.COLYSEUS_PORT || 2567}/podid`, { timeout: 2500 })
                .then(res => ({ ip, podId: res.data.podId }))
                .catch(() => null)
        )
    );

    for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.podId === podId) {
            const ip = result.value.ip;
            // Кэшируем на 15 секунд
            POD_CACHE.set(podId, { ip, expiresAt: Date.now() + 15_000 });
            return ip;
        }
    }

    return null;
}

const server = http.createServer(async (req, res) => {
    const podId = req.url.split('/')[1];
    if (!podId) return res.end('Bad request');

    const ip = await getIpForPod(podId);
    if (!ip) {
        res.writeHead(404);
        return res.end('Pod not found or unhealthy');
    }

    proxy.web(req, res, {
        target: `http://${ip}:${process.env.COLYSEUS_PORT || 2567}`,
        secure: false,
    });
});

server.on('upgrade', async (req, socket, head) => {
    const podId = req.url.split('/')[1];
    if (!podId) return socket.destroy();

    const ip = await getIpForPod(podId);
    if (!ip) return socket.destroy();

    proxy.ws(req, socket, head, {
        target: `ws://${ip}:${process.env.COLYSEUS_PORT || 2567}`,
    });
});

server.listen(process.env.PORT || 80);