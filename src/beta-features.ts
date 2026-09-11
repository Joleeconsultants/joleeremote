import { parseJsonFrameObject } from './json-frame';
import type { Envelope } from './envelope';
export type BetaFeatures = { printingBeta: boolean; microphoneBeta: boolean };
export function betaFeatures(value: unknown): BetaFeatures {
  const v = value as Partial<BetaFeatures> | null;
  return {printingBeta:v?.printingBeta === true, microphoneBeta:v?.microphoneBeta === true};
}
/** Only recognized beta channels are blocked; PC sound and ordinary input remain available. */
export function betaMessageAllowed(envelope: Envelope, flags: BetaFeatures): boolean {
  if (envelope.kind === 'audio') return true;
  const value = parseJsonFrameObject(envelope.payload);
  if (!value) return true;
  if (envelope.kind === 'frame') return flags.printingBeta || (value.t !== 'print' && value.type !== 'print');
  if (flags.microphoneBeta) return true;
  if (value.t === 'mic' || value.t === 'microphone') return false;
  if (value.t === 'pipeline' && value.pipeline === 'microphone') return value.enabled === false;
  if (value.t === 'audioDevice' && value.context === 'input') return false;
  if (value.t === 'settings' && value.settings && typeof value.settings === 'object') {
    return !Object.keys(value.settings).some(key => /^(microphone|mic)(_|$)/i.test(key));
  }
  return true;
}
