// User 面板业务逻辑：用户资料加载 / 保存 / 头像上传 / 定位 / 时区 / 性别选择
// 副作用导入：模块加载时执行事件绑定 + 初始加载。

import {
  avatarEl, uploadAvatarBtn,
  userDefaultCityInput, userNicknameInput, userCallPrefInput,
  userBirthdayInput, userGenderGroup, weatherLocationModeSelect,
  locationStatusField, locationStatus, refreshLocationBtn,
  timezoneModeSelect, manualTimezoneField, userTimezoneInput,
} from "./dom";

const avatarImg = avatarEl?.querySelector("img") as HTMLImageElement | null;
const avatarPlaceholder = avatarEl?.querySelector("span") as HTMLElement | null;

function showAvatar(dataUrl: string | null): void {
  if (!dataUrl || !avatarEl) return;
  if (!avatarEl) return;
  let img = avatarEl.querySelector("img");
  if (!img) {
    img = document.createElement("img");
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.borderRadius = "50%";
    img.style.objectFit = "cover";
    avatarEl.appendChild(img);
  }
  img.src = dataUrl;
  if (avatarPlaceholder) avatarPlaceholder.style.display = "none";
}

function syncLocationAndTimezoneFields(): void {
  const automatic = weatherLocationModeSelect?.value === "auto";
  if (locationStatusField) locationStatusField.style.display = automatic ? "block" : "none";
  if (manualTimezoneField) manualTimezoneField.style.display = timezoneModeSelect?.value === "manual" ? "block" : "none";
}

function renderLocationStatus(location: { accuracy: number; obtainedAt: number } | null): void {
  if (!locationStatus) return;
  if (!location) {
    locationStatus.textContent = "尚未获取；天气将回退到默认城市";
    return;
  }
  const accuracyKm = Math.max(0.1, location.accuracy / 1000).toFixed(location.accuracy >= 10_000 ? 0 : 1);
  locationStatus.textContent = `已获取，精度约 ${accuracyKm} km，更新于 ${new Date(location.obtainedAt).toLocaleString()}`;
}

async function refreshCurrentLocation(): Promise<void> {
  if (!refreshLocationBtn) return;
  refreshLocationBtn.disabled = true;
  refreshLocationBtn.textContent = "定位中…";
  if (locationStatus) locationStatus.textContent = "正在请求系统定位权限…";
  try {
    const result = await window.cyreneLocation?.refresh();
    if (result?.ok && result.location) {
      renderLocationStatus(result.location);
    } else if (locationStatus) {
      const messages: Record<string, string> = {
        "permission-denied": "定位权限被拒绝，将使用默认城市",
        "timeout": "定位超时，将使用默认城市",
        "position-unavailable": "系统暂时无法定位，将使用默认城市",
        "geolocation-unavailable": "当前系统不支持定位，将使用默认城市",
      };
      locationStatus.textContent = messages[result?.error ?? ""] ?? "定位失败，将使用默认城市";
    }
  } finally {
    refreshLocationBtn.disabled = false;
    refreshLocationBtn.textContent = "重新定位";
  }
}

async function loadUserProfile(): Promise<void> {
  try {
    const avatarDataUrl = await window.user?.getAvatar();
    if (avatarDataUrl) showAvatar(avatarDataUrl);
    if (uploadAvatarBtn) uploadAvatarBtn.disabled = false;
    // 加载用户字段（昵称/称呼偏好/生日/默认城市）
    const profile = await window.user?.getProfile();
    if (profile) {
      if (userNicknameInput) userNicknameInput.value = String(profile.nickname ?? "");
      if (userCallPrefInput) userCallPrefInput.value = String(profile.callPreference ?? "");
      if (userBirthdayInput) userBirthdayInput.value = String(profile.birthday ?? "");
      if (userDefaultCityInput) userDefaultCityInput.value = String(profile.defaultCity ?? "");
      if (weatherLocationModeSelect) weatherLocationModeSelect.value = profile.weatherLocationMode ?? "fixed";
      if (timezoneModeSelect) timezoneModeSelect.value = profile.timezoneMode ?? "system";
      if (userTimezoneInput) userTimezoneInput.value = String(profile.timezone ?? "");
      // 性别：标记当前选中的按钮
      const gender = String(profile.gender ?? "secret");
      if (userGenderGroup) {
        userGenderGroup.querySelectorAll(".gender-select__btn").forEach((btn) => {
          btn.classList.toggle("is-active", (btn as HTMLElement).dataset.gender === gender);
        });
      }
    }
    const systemTimezone = window.cyreneLocation?.systemTimezone() ?? "UTC";
    const systemOption = timezoneModeSelect?.querySelector('option[value="system"]');
    if (systemOption) systemOption.textContent = `跟随系统（${systemTimezone}）`;
    renderLocationStatus(await window.cyreneLocation?.getStatus() ?? null);
    syncLocationAndTimezoneFields();
  } catch {
    console.warn("[settings] load user profile failed");
  }
}

// 用户字段：失焦/回车保存（每个字段独立原子保存）
function bindUserProfileSave(input: HTMLInputElement | null, field: string): void {
  if (!input) return;
  const save = (): void => { void window.user?.saveProfile({ [field]: input.value.trim() }); };
  input.addEventListener("change", save);
  input.addEventListener("blur", save);
}

// ===== 事件绑定（模块加载时执行） =====
bindUserProfileSave(userNicknameInput, "nickname");
bindUserProfileSave(userCallPrefInput, "callPreference");
bindUserProfileSave(userBirthdayInput, "birthday");
// 默认城市复用上面的 saveCity（保持原逻辑）
if (userDefaultCityInput) {
  const saveCity = (): void => {
    const value = userDefaultCityInput.value.trim();
    void window.user?.saveProfile({ defaultCity: value });
  };
  userDefaultCityInput.addEventListener("change", saveCity);
  userDefaultCityInput.addEventListener("blur", saveCity);
}

weatherLocationModeSelect?.addEventListener("change", () => {
  const mode = weatherLocationModeSelect.value as "auto" | "fixed" | "off";
  void window.user?.saveProfile({ weatherLocationMode: mode });
  syncLocationAndTimezoneFields();
  if (mode === "auto") void refreshCurrentLocation();
  if (mode === "off") {
    void window.cyreneLocation?.clear();
    renderLocationStatus(null);
  }
});
refreshLocationBtn?.addEventListener("click", () => void refreshCurrentLocation());
timezoneModeSelect?.addEventListener("change", () => {
  void window.user?.saveProfile({ timezoneMode: timezoneModeSelect.value });
  syncLocationAndTimezoneFields();
});
if (userTimezoneInput) {
  const saveTimezone = (): void => { void window.user?.saveProfile({ timezone: userTimezoneInput.value.trim() }); };
  userTimezoneInput.addEventListener("change", saveTimezone);
  userTimezoneInput.addEventListener("blur", saveTimezone);
}

// 性别：三档按钮，点击切换并原子保存
if (userGenderGroup) {
  userGenderGroup.querySelectorAll(".gender-select__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = (btn as HTMLElement).dataset.gender;
      if (!value) return;
      userGenderGroup.querySelectorAll(".gender-select__btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      void window.user?.saveProfile({ gender: value });
    });
  });
}

if (uploadAvatarBtn) {
  uploadAvatarBtn.addEventListener("click", async () => {
    try {
      const result = await window.user?.uploadAvatar();
      if (result?.avatarPath) {
        const avatarDataUrl = await window.user?.getAvatar();
        if (avatarDataUrl) showAvatar(avatarDataUrl);
      }
    } catch (err) {
      console.error("[settings] upload avatar failed", err);
    }
  });
}

// 模块加载时拉一次配置
void loadUserProfile();
