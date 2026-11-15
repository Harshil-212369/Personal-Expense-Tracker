import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource-variable/fraunces';
import './styles.css';

import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.tsx';
import { ToastProvider } from './components/common.tsx';
import { ApiError, tokenStore } from './lib/api.ts';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Retrying a 4xx only repeats the same answer; retry transient failures once.
      retry: (failures, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 1,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      // The server was started with API_TOKEN: ask for it once per tab.
      if (error instanceof ApiError && error.status === 401) {
        const token = window.prompt('This LedgerLens server requires its API token:');
        if (token) {
          tokenStore.set(token.trim());
          void queryClient.invalidateQueries();
        }
      }
    },
  }),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
