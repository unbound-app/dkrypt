import { getQueryParam, setQueryParams } from '#lib/urlState';

const DEFAULT_PROJECT_ID = 'default';

function readStoredProjectId(): string {
  return getQueryParam('projectId') || localStorage.getItem('dkryptProjectId') || DEFAULT_PROJECT_ID;
}

export const projectSelectionState = $state({ id: readStoredProjectId() });

export function setProjectSelection(id: string): void {
  projectSelectionState.id = id || DEFAULT_PROJECT_ID;
  localStorage.setItem('dkryptProjectId', projectSelectionState.id);
  setQueryParams({ projectId: projectSelectionState.id === DEFAULT_PROJECT_ID ? undefined : projectSelectionState.id });
}
