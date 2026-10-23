import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
function publicAddress(address: string) { if (address.includes(':'))
    return !/^(::|fc|fd|fe|ff|2001:db8)/i.test(address); const [a, b] = address.split('.').map(Number); return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224 || a === 198 && (b === 18 || b === 19)); }
export function integrationUrl(value: string) { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new BadRequestException('Use an HTTPS integration URL without credentials or query parameters.'); return url; }
/** Resolve once and connect to the checked address. No redirect or DNS rebinding fallback. */
export async function integrationHttp(url: URL, token: string, method: string, body?: Record<string, unknown> | Buffer, contentType = 'application/json', limit = 8 * 1024 * 1024): Promise<{
    buffer: Buffer;
    mime: string;
}> {
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
    if (!addresses.length || addresses.some(a => !publicAddress(a.address)))
        throw new BadRequestException('The integration host must resolve to a public address.');
    const address = addresses[0];
    const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => { const req = request({ hostname: address.address, family: address.family, port: url.port || 443, servername: url.hostname, method, path: url.pathname + url.search, headers: { Host: url.host, api_access_token: token, Accept: 'application/json', ...(bytes ? { 'Content-Type': contentType, 'Content-Length': bytes.length } : {}) }, timeout: 30000 }, res => { if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`Integration rejected the request (${res.statusCode ?? 0}).`));
        return;
    } let size = 0; const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) {
        res.destroy(new Error('Integration response is too large.'));
        return;
    } chunks.push(chunk); }); res.on('error', reject); res.on('end', () => resolve({ buffer: Buffer.concat(chunks), mime: res.headers['content-type']?.split(';')[0] ?? 'application/octet-stream' })); }); req.on('timeout', () => req.destroy(new Error('Integration request timed out; write outcome may be unknown.'))); req.on('error', reject); if (bytes)
        req.write(bytes); req.end(); });
}
