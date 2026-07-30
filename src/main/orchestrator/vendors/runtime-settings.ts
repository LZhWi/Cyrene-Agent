export interface VendorRuntimeSettings {
  thinkingOverride?: -1 | 0 | 1;
  disableMaxToken?: boolean;
}

let settingsGetter: (() => VendorRuntimeSettings) | null = null;

export function setVendorRuntimeSettingsGetter(
  getter: () => VendorRuntimeSettings,
): void {
  settingsGetter = getter;
}

export function getVendorRuntimeSettings(): VendorRuntimeSettings {
  return settingsGetter?.() ?? {};
}
