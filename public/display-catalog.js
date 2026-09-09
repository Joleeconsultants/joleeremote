// Windows supplies this catalog. Never infer supported modes from a frame size.
const opaqueId = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
const dimension = value => Number.isInteger(value) && value > 0 && value <= 65535;
export function readDisplayCatalog(value) {
  if (!value || !opaqueId(value.revision) || !(value.selected_display_id === null || opaqueId(value.selected_display_id)) ||
      !Array.isArray(value.displays) || !value.displays.length || value.displays.length > 16) return null;
  const displayIds = new Set();
  for (const display of value.displays) {
    if (!display || !opaqueId(display.id) || displayIds.has(display.id) ||
        typeof display.label !== 'string' || !display.label.length || display.label.length > 128 ||
        typeof display.primary !== 'boolean' || typeof display.can_resize !== 'boolean' ||
        !Number.isInteger(display.x) || Math.abs(display.x)>65535 || !Number.isInteger(display.y) || Math.abs(display.y)>65535 ||
        !dimension(display.width) || !dimension(display.height) || !opaqueId(display.current_mode_id) ||
        ![null,'session_unavailable','capture_limit','display_changed'].includes(display.reason) ||
        !Array.isArray(display.modes) || !display.modes.length || display.modes.length > 512) return null;
    displayIds.add(display.id);
    const modeIds = new Set();
    for (const mode of display.modes) {
      if (!mode || !opaqueId(mode.id) || modeIds.has(mode.id) || !dimension(mode.width) ||
          !dimension(mode.height) || !Number.isFinite(mode.refresh_hz) || mode.refresh_hz < 0 ||
          mode.refresh_hz > 10000 || typeof mode.selectable !== 'boolean' ||
          !(mode.selectable ? mode.reason === null : ['capture_limit','format_change_unsupported','windows_rejected'].includes(mode.reason))) return null;
      modeIds.add(mode.id);
    }
    if (!modeIds.has(display.current_mode_id)) return null;
  }
  return value.selected_display_id === null || displayIds.has(value.selected_display_id) ? value : null;
}
export function selectedDisplay(catalog) {
  return catalog?.displays.find(display => display.id === catalog.selected_display_id) ?? null;
}
export function resolutionChoices(display) {
  if (!display) return [];
  const current = display.modes.find(mode => mode.id === display.current_mode_id);
  const groups = new Map();
  for (const mode of display.modes) {
    const value = `${mode.width}x${mode.height}`;
    const previous = groups.get(value);
    // Prefer a selectable mode, then the current refresh rate and a stable ID.
    const rank = candidate => [candidate.selectable ? 0 : 1,
      Math.abs(candidate.refresh_hz - (current?.refresh_hz ?? 60)), candidate.id];
    const a = rank(mode), b = previous && rank(previous);
    if (!previous || a[0] < b[0] || a[0] === b[0] && (a[1] < b[1] || a[1] === b[1] && a[2] < b[2])) groups.set(value, mode);
  }
  return [...groups].map(([value, mode]) => ({value, mode,
    current: value === `${display.width}x${display.height}`}))
    .sort((a, b) => a.mode.width * a.mode.height - b.mode.width * b.mode.height || a.mode.width - b.mode.width);
}
