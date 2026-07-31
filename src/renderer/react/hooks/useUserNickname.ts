import { useEffect, useState } from "react";

interface UserProfile {
  nickname?: string;
}

interface UserProfileApi {
  getProfile: () => Promise<UserProfile | null>;
  onProfileChanged: (callback: (profile: UserProfile) => void) => () => void;
}

function userProfileApi(): UserProfileApi | undefined {
  return (window as typeof window & { user?: UserProfileApi }).user;
}

function normalizeNickname(profile?: UserProfile | null): string {
  return typeof profile?.nickname === "string" ? profile.nickname.trim() : "";
}

export function useUserNickname(): string {
  const [nickname, setNickname] = useState("");

  useEffect(() => {
    let active = true;
    const api = userProfileApi();

    void api?.getProfile()
      .then((profile) => {
        if (active) setNickname(normalizeNickname(profile));
      })
      .catch(() => {
        if (active) setNickname("");
      });

    const unsubscribe = api?.onProfileChanged((profile) => {
      if (active) setNickname(normalizeNickname(profile));
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  return nickname;
}
