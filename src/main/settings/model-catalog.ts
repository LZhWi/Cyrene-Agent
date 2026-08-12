import type { ProviderProfile } from "./model-settings";

export interface SavedModelProfile extends ProviderProfile {
  id: string;
  provider: string;
}

export function sameModelCredential(left: SavedModelProfile, right: SavedModelProfile): boolean {
  return left.apiKey.trim() === right.apiKey.trim() && left.model.trim() === right.model.trim();
}

export function addModelProfile(
  profiles: SavedModelProfile[],
  profile: SavedModelProfile,
): { profiles: SavedModelProfile[]; added: boolean } {
  if (profiles.some((saved) => sameModelCredential(saved, profile))) {
    return { profiles, added: false };
  }
  return { profiles: [...profiles, profile], added: true };
}

export function resolveDefaultModelProfile(
  profiles: SavedModelProfile[],
  defaultModelProfileId: string | undefined,
): SavedModelProfile | undefined {
  return profiles.find((profile) => profile.id === defaultModelProfileId) ?? profiles[0];
}
