export function isAudioMediaCheck(mediaType: string | undefined): boolean {
  return mediaType === "audio";
}

export function isAudioOnlyMediaRequest(mediaTypes: readonly string[] | undefined): boolean {
  return Array.isArray(mediaTypes)
    && mediaTypes.length > 0
    && mediaTypes.every((mediaType) => mediaType === "audio");
}
