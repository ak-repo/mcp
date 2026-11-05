import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { AppProviders } from './app/providers.js';
import { createAppRouter } from './app/router.js';
export default function App() {
  const [router] = useState(createAppRouter);
  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
