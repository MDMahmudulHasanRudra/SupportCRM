export interface GoWaOperation {
    id: string;
    method: string;
    route: string;
    title: string;
    category: string;
    description: string;
    mode: string;
    multipart: boolean;
    parameters: Array<{
        name: string;
        location: string;
        required: boolean;
        schema: Record<string, unknown>;
        description: string;
    }>;
    body: Record<string, unknown>;
}
export type { ChannelCommand } from '../channel-adapter.interface';
export interface ToolUploadFile {
    buffer: Buffer;
    size: number;
    originalname: string;
    mimetype: string;
}
