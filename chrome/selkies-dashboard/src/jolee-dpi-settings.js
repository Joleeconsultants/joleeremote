// DPI is an agent capability, unlike the dashboard's local canvas scaling.
export function canSetDpi(setting, supported, value) {
  return supported === true && !!setting && !setting.locked && !setting.overridden
    && Number.isInteger(value) && setting.allowed?.includes(String(value)) === true;
}

export function initialDpi(setting, stored, derived, supported) {
  if (!setting) return null;
  const serverValue = Number.parseInt(setting.value, 10);
  const storedAllowed = setting.allowed?.includes(String(stored)) === true;
  const value = setting.overridden || setting.locked ? serverValue
    : storedAllowed ? stored : derived;
  return {
    value,
    post: !storedAllowed && derived !== serverValue && canSetDpi(setting, supported, derived)
      ? derived : null,
  };
}

// Recheck at flush time: capabilities can change during the debounce window.
// Preserve other coalesced settings when DPI is no longer writable.
export function filterDpiSetting(settings, setting, supported) {
  if (!Object.hasOwn(settings, 'scaling_dpi') || canSetDpi(setting, supported, settings.scaling_dpi))
    return settings;
  const { scaling_dpi: ignored, ...remaining } = settings;
  return remaining;
}
