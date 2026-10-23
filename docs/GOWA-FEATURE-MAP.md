# Go WhatsApp v9.6.0 feature coverage

Generated from the pinned OpenAPI snapshot by `node scripts/sync-gowa-contract.cjs`. **97 native operations** are mapped below. Catalogue presence describes implemented source workflows, not successful provider acceptance. Account/webhook, schedule and Chatwoot operations use explicit managed controls; they are not an unrestricted proxy.

| Native operation | API | Workspace entry | Delivery / limits |
|---|---|---|---|
| `health` | `GET /health` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `appLogin` | `GET /app/login` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `appLoginWithCode` | `GET /app/login-with-code` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `appPasskeyStatus` | `GET /app/passkey` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `appPasskeyResponse` | `POST /app/passkey/response` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `appPasskeyConfirm` | `POST /app/passkey/confirm` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `appLogout` | `GET /app/logout` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `appReconnect` | `GET /app/reconnect` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `appDevices` | `GET /app/devices` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `appStatus` | `GET /app/status` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `appInfo` | `GET /app/info` | All features / app | Authorized typed native read. |
| `listDevices` | `GET /devices` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `addDevice` | `POST /devices` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `getDevice` | `GET /devices/{device_id}` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `removeDevice` | `DELETE /devices/{device_id}` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `loginDevice` | `GET /devices/{device_id}/login` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `loginDeviceWithCode` | `POST /devices/{device_id}/login/code` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `logoutDevice` | `POST /devices/{device_id}/logout` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `reconnectDevice` | `POST /devices/{device_id}/reconnect` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `getDeviceStatus` | `GET /devices/{device_id}/status` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `getDeviceWebhook` | `GET /devices/{device_id}/webhook` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `updateDeviceWebhook` | `PATCH /devices/{device_id}/webhook` | Linked devices / account detail / settings | Managed account lifecycle, pairing and callback provisioning; raw provider secrets are not exposed. |
| `userInfo` | `GET /user/info` | All features / user | Authorized typed native read. |
| `userAvatar` | `GET /user/avatar` | All features / user | Authorized typed native read. |
| `userChangeAvatar` | `POST /user/avatar` | All features / user | Queued audited native action. |
| `userChangePushName` | `POST /user/pushname` | All features / user | Queued audited native action. |
| `userMyPrivacy` | `GET /user/my/privacy` | All features / user | Authorized typed native read. |
| `userMyGroups` | `GET /user/my/groups` | All features / user | Authorized typed native read. |
| `userMyNewsletter` | `GET /user/my/newsletters` | All features / user | Authorized typed native read. |
| `userMyContacts` | `GET /user/my/contacts` | All features / user | Authorized typed native read. |
| `userCheck` | `GET /user/check` | All features / user | Authorized typed native read. |
| `userBusinessProfile` | `GET /user/business-profile` | All features / user | Authorized typed native read. |
| `sendMessage` | `POST /send/message` | Chat share/composer / All features | Outbound queue, real provider ID and server controls; optional CRM recurrence. |
| `sendImage` | `POST /send/image` | Chat share/composer / All features | Outbound queue, real provider ID and server controls; optional CRM recurrence. |
| `sendAudio` | `POST /send/audio` | Chat share/composer / All features | Outbound queue, real provider ID and server controls; optional CRM recurrence. |
| `sendFile` | `POST /send/file` | Chat share/composer / All features | Outbound queue, real provider ID and server controls; optional CRM recurrence. |
| `sendSticker` | `POST /send/sticker` | Chat share/composer / All features | Outbound queue, real provider ID and server controls; optional CRM recurrence. |
| `sendVideo` | `POST /send/video` | Chat share/composer / All features | Outbound queue, real provider ID and server controls; optional CRM recurrence. |
| `sendContact` | `POST /send/contact` | Chat share/composer / All features | Outbound queue, real provider ID and server controls; optional CRM recurrence. |
| `sendLink` | `POST /send/link` | Send & share / Link | Shares text by default; native previews only for explicitly trusted deployment hosts. |
| `sendLocation` | `POST /send/location` | Chat share/composer / All features | Outbound queue, real provider ID and server controls; optional CRM recurrence. |
| `sendPoll` | `POST /send/poll` | Chat share/composer / All features | Outbound queue, real provider ID and server controls; optional CRM recurrence. |
| `sendPresence` | `POST /send/presence` | All features / send | Queued audited native action. |
| `sendChatPresence` | `POST /send/chat-presence` | All features / send | Queued audited native action. |
| `listScheduledSends` | `GET /send/schedules` | Scheduled / schedule tools | CRM schedule UUIDs and workers; native scheduler never bypasses CRM dispatch controls. |
| `getScheduledSend` | `GET /send/schedules/{schedule_id}` | Scheduled / schedule tools | CRM schedule UUIDs and workers; native scheduler never bypasses CRM dispatch controls. |
| `pauseScheduledSend` | `POST /send/schedules/{schedule_id}/pause` | Scheduled / schedule tools | CRM schedule UUIDs and workers; native scheduler never bypasses CRM dispatch controls. |
| `resumeScheduledSend` | `POST /send/schedules/{schedule_id}/resume` | Scheduled / schedule tools | CRM schedule UUIDs and workers; native scheduler never bypasses CRM dispatch controls. |
| `cancelScheduledSend` | `POST /send/schedules/{schedule_id}/cancel` | Scheduled / schedule tools | CRM schedule UUIDs and workers; native scheduler never bypasses CRM dispatch controls. |
| `revokeMessage` | `POST /message/{message_id}/revoke` | Message menu / All features | Queued audited native actions; edits/deletes retain the support record. |
| `deleteMessage` | `POST /message/{message_id}/delete` | Message menu / All features | Queued audited native actions; edits/deletes retain the support record. |
| `reactMessage` | `POST /message/{message_id}/reaction` | Message menu / All features | Queued audited native actions; edits/deletes retain the support record. |
| `updateMessage` | `POST /message/{message_id}/update` | Message menu / All features | Queued audited native actions; edits/deletes retain the support record. |
| `readMessage` | `POST /message/{message_id}/read` | Message menu / All features | Queued audited native actions; edits/deletes retain the support record. |
| `markMessagePlayed` | `POST /message/{message_id}/played` | Message menu / All features | Queued audited native actions; edits/deletes retain the support record. |
| `starMessage` | `POST /message/{message_id}/star` | Message menu / All features | Queued audited native actions; edits/deletes retain the support record. |
| `unstarMessage` | `POST /message/{message_id}/unstar` | Message menu / All features | Queued audited native actions; edits/deletes retain the support record. |
| `forwardMessage` | `POST /message/{message_id}/forward` | Chat share/composer / All features | Outbound queue, real provider ID and server controls; optional CRM recurrence. |
| `downloadMessageMedia` | `GET /message/{message_id}/download` | Chat / Channels / tools | Private authenticated bounded media storage/streaming. |
| `rejectCall` | `POST /call/reject` | All features / call | Queued audited native action. |
| `listChats` | `GET /chats` | All features / chat | Authorized typed native read. |
| `getChatMessages` | `GET /chat/{chat_jid}/messages` | All features / chat | Authorized typed native read. |
| `requestChatHistory` | `POST /chat/{chat_jid}/history` | All features / chat | Queued audited native action. |
| `pinChat` | `POST /chat/{chat_jid}/pin` | All features / chat | Queued audited native action. |
| `setDisappearingTimer` | `POST /chat/{chat_jid}/disappearing` | All features / chat | Queued audited native action. |
| `archiveChat` | `POST /chat/{chat_jid}/archive` | All features / chat | Queued audited native action. |
| `groupInfo` | `GET /group/info` | All features / group | Authorized typed native read. |
| `createGroup` | `POST /group` | All features / group | Queued audited native action. |
| `getGroupParticipants` | `GET /group/participants` | All features / group | Authorized typed native read. |
| `addParticipantToGroup` | `POST /group/participants` | All features / group | Queued audited native action. |
| `exportGroupParticipants` | `GET /group/participants/export` | All features / group | Authorized typed native read. |
| `removeParticipantFromGroup` | `POST /group/participants/remove` | All features / group | Queued audited native action. |
| `promoteParticipantToAdmin` | `POST /group/participants/promote` | All features / group | Queued audited native action. |
| `demoteParticipantToMember` | `POST /group/participants/demote` | All features / group | Queued audited native action. |
| `joinGroupWithLink` | `POST /group/join-with-link` | All features / group | Queued audited native action. |
| `getGroupInfoFromLink` | `GET /group/info-from-link` | All features / group | Authorized typed native read. |
| `getGroupParticipantRequests` | `GET /group/participant-requests` | All features / group | Authorized typed native read. |
| `approveGroupParticipantRequest` | `POST /group/participant-requests/approve` | All features / group | Queued audited native action. |
| `rejectGroupParticipantRequest` | `POST /group/participant-requests/reject` | All features / group | Queued audited native action. |
| `leaveGroup` | `POST /group/leave` | All features / group | Queued audited native action. |
| `setGroupPhoto` | `POST /group/photo` | All features / group | Queued audited native action. |
| `setGroupName` | `POST /group/name` | All features / group | Queued audited native action. |
| `setGroupLocked` | `POST /group/locked` | All features / group | Queued audited native action. |
| `setGroupAnnounce` | `POST /group/announce` | All features / group | Queued audited native action. |
| `setGroupTopic` | `POST /group/topic` | All features / group | Queued audited native action. |
| `groupInviteLink` | `GET /group/invite-link` | All features / group | Queued audited native action. |
| `unfollowNewsletter` | `POST /newsletter/unfollow` | All features / newsletter | Queued audited native action. |
| `getNewsletterMessages` | `GET /newsletter/messages` | All features / newsletter | Authorized typed native read. |
| `downloadNewsletterMessageMedia` | `GET /newsletter/messages/{server_id}/download` | Chat / Channels / tools | Private authenticated bounded media storage/streaming. |
| `chatwootSyncHistory` | `POST /chatwoot/sync` | All features / Integrations | Encrypted CRM configuration, background history/mirror and queued replies; requires a real configured service. |
| `chatwootSyncStatus` | `GET /chatwoot/sync/status` | All features / Integrations | Encrypted CRM configuration, background history/mirror and queued replies; requires a real configured service. |
| `chatwootWebhook` | `POST /chatwoot/webhook` | Settings / Chatwoot callback | Authenticated per-account CRM callback, not the provider direct-send webhook. |
| `chatwootDeviceWebhook` | `POST /chatwoot/webhook/{device_id}` | Settings / Chatwoot callback | Authenticated per-account CRM callback, not the provider direct-send webhook. |
| `chatwootListConfigs` | `GET /chatwoot/configs` | All features / Integrations | Encrypted CRM configuration, background history/mirror and queued replies; requires a real configured service. |
| `chatwootGetDeviceConfig` | `GET /devices/{device_id}/chatwoot/config` | All features / Integrations | Encrypted CRM configuration, background history/mirror and queued replies; requires a real configured service. |
| `chatwootUpsertDeviceConfig` | `PUT /devices/{device_id}/chatwoot/config` | All features / Integrations | Encrypted CRM configuration, background history/mirror and queued replies; requires a real configured service. |
| `chatwootDeleteDeviceConfig` | `DELETE /devices/{device_id}/chatwoot/config` | All features / Integrations | Encrypted CRM configuration, background history/mirror and queued replies; requires a real configured service. |

Additional CRM workflows: native chat history import without automatic decisions, private unread/archive, shared pins, upload/voice composition, status-event viewing, structured poll vote observations, typing indicators, webhook-backed labels, optional MCP action inspection/cancellation and existing support automation/broadcast flows.

Native constraints: no disconnect-without-logout endpoint; joined-group discovery may be limited to approximately 500 groups; newsletter REST supports reads/media/unfollow rather than creation/follow; label updates are webhook-backed and edited on the phone; no native poll-vote send endpoint is invented. View-once media stays a phone flow. WhatsApp delivery/history availability, service configuration, permissions, ownership and provider-side rights still govern each action.
