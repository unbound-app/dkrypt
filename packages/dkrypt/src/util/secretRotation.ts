export function isValidCredentialRotation(current: string, previous: string, minimumLength: number): boolean {
  return current.length >= minimumLength && previous.length >= minimumLength && current !== previous;
}
