const DEFAULT_PROJECT_ID = 'default';

function readStoredProjectId(): string {
  return localStorage.getItem('dkryptProjectId') || DEFAULT_PROJECT_ID;
}

export const projectSelectionState = $state({ id: readStoredProjectId() });

export function setProjectSelection(id: string): void {
  projectSelectionState.id = id || DEFAULT_PROJECT_ID;
  localStorage.setItem('dkryptProjectId', projectSelectionState.id);
}
