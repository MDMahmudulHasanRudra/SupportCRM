/** Transport-neutral failure for the active WhatsApp adapter boundary. */
export class GatewayError extends Error {
    constructor(readonly status: number, readonly path: string, readonly body: string) { super(body); this.name = 'GatewayError'; }
}
