interface UserAvatarProps {
  label?: string;
}

export function UserAvatar({ label = "User" }: UserAvatarProps) {
  return (
    <div className="cy-user-avatar">
      <div className="cy-user-avatar-circle">
        <span>U</span>
      </div>
      <span className="cy-user-avatar-label">{label}</span>
    </div>
  );
}
