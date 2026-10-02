import { untrack } from 'svelte';

export interface FormDraftRecord<T> {
  values: T;
  savedAt: number;
}

export const unsavedFormsState = $state<{ ids: string[] }>({ ids: [] });
let beforeUnloadAttached = false;

function preventDataLoss(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = '';
}

function updateBeforeUnloadGuard(): void {
  if (typeof window === 'undefined') return;
  const shouldAttach = untrack(() => unsavedFormsState.ids.length > 0);
  if (shouldAttach === beforeUnloadAttached) return;
  beforeUnloadAttached = shouldAttach;
  if (shouldAttach) window.addEventListener('beforeunload', preventDataLoss);
  else window.removeEventListener('beforeunload', preventDataLoss);
}

export function readFormDraft<T>(key: string): FormDraftRecord<T> | undefined {
  try {
    const value = localStorage.getItem(`dkrypt-form-draft:${key}`);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as FormDraftRecord<T>;
    return parsed && typeof parsed === 'object' && 'values' in parsed ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeFormDraft<T>(key: string, values: T): void {
  try {
    localStorage.setItem(`dkrypt-form-draft:${key}`, JSON.stringify({ values, savedAt: Date.now() } satisfies FormDraftRecord<T>));
  } catch {
    return;
  }
}

export function clearFormDraft(key: string): void {
  try {
    localStorage.removeItem(`dkrypt-form-draft:${key}`);
  } catch {
    return;
  }
}

export function setFormUnsaved(id: string, unsaved: boolean): void {
  const currentIds = untrack(() => unsavedFormsState.ids);
  if (currentIds.includes(id) === unsaved) return;
  if (unsaved) {
    unsavedFormsState.ids = [...currentIds, id];
    updateBeforeUnloadGuard();
    return;
  }
  unsavedFormsState.ids = currentIds.filter((current) => current !== id);
  updateBeforeUnloadGuard();
}

export function clearUnsavedFormWarnings(): void {
  unsavedFormsState.ids = [];
  updateBeforeUnloadGuard();
}
