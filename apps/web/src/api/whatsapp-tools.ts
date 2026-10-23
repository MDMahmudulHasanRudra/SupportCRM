import {api,API_URL,ApiError} from './client';
export interface ToolSchema {type?:string;format?:string;description?:string;enum?:unknown[];default?:unknown;properties?:Record<string,ToolSchema>;required?:string[];items?:ToolSchema;minimum?:number;maximum?:number;maxLength?:number;maxItems?:number;oneOf?:ToolSchema[];anyOf?:ToolSchema[]}
export interface WhatsAppTool {id:string;title:string;category:string;mode:string;multipart:boolean;parameters:Array<{name:string;location:string;required:boolean;schema:ToolSchema;description:string}>;body:ToolSchema;permissions:string[];disabledReason:string|null}
export interface WhatsAppAction {id:string;operationId:string;status:string;outboundId:string|null;jobId:string|null;result:unknown;error:string|null;createdAt:string}
export interface ToolInput {parameters:Record<string,unknown>;body:Record<string,unknown>}
const base='/channels/whatsapp/tools';
export const whatsappTools={
 catalogue:()=>api.get<{provider:string;version:string;operations:WhatsAppTool[]}>(`${base}/catalogue`),
 read:(account:string,operation:string,input:ToolInput)=>api.post<unknown>(`${base}/accounts/${account}/read/${operation}`,input),
 submit:(account:string,operation:string,input:ToolInput&{requestKey:string;confirmed:boolean;files?:Record<string,string>;scheduledFor?:string})=>api.post<WhatsAppAction>(`${base}/accounts/${account}/actions/${operation}`,input),
 actions:(account:string)=>api.get<{items:WhatsAppAction[]}>(`${base}/accounts/${account}/actions`),
 action:(account:string,id:string)=>api.get<WhatsAppAction>(`${base}/accounts/${account}/actions/${id}`),
 cancel:(account:string,id:string)=>api.post<WhatsAppAction>(`${base}/accounts/${account}/actions/${id}/cancel`),
 async upload(account:string,file:File){const form=new FormData();form.append('file',file);const res=await fetch(`${API_URL}/api/v1${base}/accounts/${account}/uploads`,{method:'POST',credentials:'include',body:form});const payload=await res.json();if(!res.ok)throw new ApiError(res.status,Array.isArray(payload.message)?payload.message.join(', '):payload.message||'The upload failed.');return payload as {id:string;name:string;mime:string;size:number};},
 integrationSetup:(account:string)=>api.get<{callbackUrl:string;webhookSecret:string;authenticationHeader:string}>(`/channels/whatsapp/integrations/chatwoot/${account}/setup`),
 phoneCode:(account:string,phone:string)=>api.post<{code:string}>(`/channels/whatsapp/accounts/${account}/pairing-code`,{phone}),
 passkey:(account:string,action:'status'|'response'|'confirm',assertion?:Record<string,unknown>)=>api.post<Record<string,unknown>>(`/channels/whatsapp/accounts/${account}/passkey/${action}`,assertion?{assertion}:{}),
 removeDevice:(account:string,confirm:string)=>api.post(`/channels/whatsapp/accounts/${account}/remove-device`,{confirm}),
 labels:(account:string)=>api.get<{items:Array<{id:string;name?:string;color?:number;chats:string[]}>}>(`${base}/accounts/${account}/labels`),
 feed:(account:string)=>api.get<{items:Array<{id:string;event:string;receivedAt:string;from:string;name:string|null;body:string;timestamp:string;type:string;call:{id:string;caller:string}|null}>}>(`${base}/accounts/${account}/feed`),
 history:(account:string,query='')=>api.get<{items:Array<{id:string;eventType:string;status:string;receivedAt:string;rawPayload?:unknown}>}>(`${base}/accounts/${account}/events${query}`),
};
