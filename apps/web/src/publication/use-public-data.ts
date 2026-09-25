import { useEffect, useState } from 'react';
import { replayErrorText } from '../replay/load-message.ts';

/** Callers memoize read; late responses never replace the selected immutable document. */
export function usePublicData<T>(read: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ read: typeof read; value?: T; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setState({ read, value });
      },
      (error) => {
        if (!controller.signal.aborted) setState({ read, error: replayErrorText(error) });
      },
    );
    return () => controller.abort();
  }, [read]);
  return state?.read === read ? state : undefined;
}
