/** Presentation only. Raw speaker values remain the identity in stored segments. */
export function speakerLabel(speaker: string | null | undefined): string {
  if (speaker === undefined) return ''
  if (speaker === null) return 'Unknown speaker'
  if (!speaker.startsWith('overlap:') || speaker.length > 200) return speaker
  try {
    const members: unknown = JSON.parse(speaker.slice('overlap:'.length))
    if (
      !Array.isArray(members) ||
      members.length < 2 ||
      members.some((member) => member !== null && (typeof member !== 'string' || !member.trim())) ||
      new Set(members).size !== members.length
    )
      return speaker
    // Parse only the outer set: an individual speaker ID can contain punctuation
    // or even resemble an overlap encoding and must remain literal.
    return members.map((member) => (member === null ? 'Unknown speaker' : member)).join(' + ')
  } catch {
    return speaker
  }
}
