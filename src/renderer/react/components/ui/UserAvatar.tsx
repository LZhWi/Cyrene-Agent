import { useUserAvatar } from "../../hooks/useUserAvatar";

interface UserAvatarProps {
  label?: string;
}

export function UserAvatar({ label = "User" }: UserAvatarProps) {
  const avatarUrl = useUserAvatar();

  return (
    <div className="cy-user-avatar">
      <div className="cy-user-avatar-circle">
        {avatarUrl
          ? <img src={avatarUrl} alt="用户" draggable={false} />
          : <span>U</span>}
      </div>
      <span className="cy-user-avatar-label">{label}</span>
    </div>
  );
}
