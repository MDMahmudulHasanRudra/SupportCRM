/**
 * What a connected channel account can actually do, at runtime.
 *
 * `PROJECT_SPEC.md` §174/§176: the system must respect the real limits of the underlying transport.
 * If a feature is unsupported, detect it, disable it in the UI, explain why — and never fake
 * success. This type is how that instruction becomes enforceable rather than aspirational.
 *
 * Capabilities are per ACCOUNT, not per channel: the same WhatsApp integration can add participants
 * to one group and not another depending on admin rights, and the two gateway engines
 * (`whatsapp-web.js` vs `baileys`) differ in what they expose at all. So this is a snapshot the
 * adapter refreshes on connect, stored on `channel_accounts.capabilities`, never a constant.
 */
export interface ChannelCapabilities {
  canSendText: boolean;
  canSendMedia: boolean;
  canSendDocument: boolean;
  canReply: boolean;
  canReact: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canPin: boolean;
  canReadGroupMembers: boolean;
  canAddGroupMember: boolean;
  canRemoveGroupMember: boolean;
  canPromoteGroupMember: boolean;
  canBroadcast: boolean;
  canReceiveDeliveryStatus: boolean;
  canReceiveReadStatus: boolean;
}

export type ChannelCapabilityKey = keyof ChannelCapabilities;

/**
 * Everything off.
 *
 * The default is deliberately the most restrictive value: an account whose capabilities have never
 * been probed must behave as though it can do nothing, so a UI bug or a missed refresh produces a
 * disabled button rather than a request that fails after the user was told it would work.
 */
export const NO_CAPABILITIES: ChannelCapabilities = {
  canSendText: false,
  canSendMedia: false,
  canSendDocument: false,
  canReply: false,
  canReact: false,
  canEdit: false,
  canDelete: false,
  canPin: false,
  canReadGroupMembers: false,
  canAddGroupMember: false,
  canRemoveGroupMember: false,
  canPromoteGroupMember: false,
  canBroadcast: false,
  canReceiveDeliveryStatus: false,
  canReceiveReadStatus: false,
};

export const CAPABILITY_KEYS = Object.keys(NO_CAPABILITIES) as ChannelCapabilityKey[];

/**
 * Normalises a partial or untrusted capability object.
 *
 * An adapter (or a stored row written by an older version) may be missing keys. Anything absent or
 * non-boolean becomes `false` rather than `undefined`, so `if (caps.canAddGroupMember)` cannot be
 * accidentally truthy and unknown keys from a future version are dropped instead of leaking through.
 */
export function normalizeCapabilities(input: Partial<ChannelCapabilities> | null | undefined): ChannelCapabilities {
  const result = { ...NO_CAPABILITIES };
  if (!input) return result;
  for (const key of CAPABILITY_KEYS) {
    result[key] = input[key] === true;
  }
  return result;
}

export class ChannelCapabilityError extends Error {
  constructor(
    readonly capability: ChannelCapabilityKey,
    readonly channelAccountId: string,
  ) {
    super(
      `This channel account does not support "${capability}". ` +
        `The action was not attempted (PROJECT_SPEC.md §174: never fake success).`,
    );
    this.name = 'ChannelCapabilityError';
  }
}

/**
 * The one place an action is gated on a capability. Throws a typed, explanatory error rather than
 * returning false, so a call site cannot accidentally ignore the result and proceed.
 */
export function assertCapability(
  capabilities: ChannelCapabilities | null | undefined,
  capability: ChannelCapabilityKey,
  channelAccountId: string,
): void {
  if (!normalizeCapabilities(capabilities)[capability]) {
    throw new ChannelCapabilityError(capability, channelAccountId);
  }
}
