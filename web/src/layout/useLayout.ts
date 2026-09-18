import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { safeStorage } from '../settings/useSettings';
import { loadLayout, saveLayout } from './layout';
import type { HomeLayout } from './layout';

/** The Home layout, loaded from localStorage next to the appearance settings and saved on every change. */
export function useLayout(): [HomeLayout, Dispatch<SetStateAction<HomeLayout>>] {
  const [layout, setLayout] = useState<HomeLayout>(() => loadLayout(safeStorage()));
  useEffect(() => { saveLayout(safeStorage(), layout); }, [layout]);
  return [layout, setLayout];
}
