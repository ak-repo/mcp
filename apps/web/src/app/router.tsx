import { createBrowserRouter } from 'react-router';
import { ProtectedRoute } from '../features/auth/protected-route.js';
import { NotFound, RouteError } from './route-error.js';

export function createAppRouter() {
  return createBrowserRouter([
    {
      path: '/login',
      lazy: async () => ({ Component: (await import('../features/auth/login-page.js')).LoginPage }),
      errorElement: <RouteError />,
    },
    {
      element: <ProtectedRoute />,
      errorElement: <RouteError />,
      children: [
        {
          lazy: async () => ({ Component: (await import('./shell.js')).Shell }),
          children: [
            {
              path: '/',
              lazy: async () => ({
                Component: (await import('../features/system/system-page.js')).SystemPage,
              }),
            },
            {
              path: '/overview',
              lazy: async () => ({
                Component: (await import('../features/overview/overview-page.js')).OverviewPage,
              }),
            },
            {
              path: '/orders',
              lazy: async () => ({
                Component: (await import('../features/orders/orders-page.js')).OrdersPage,
              }),
            },
            {
              path: '/orders/:id',
              lazy: async () => ({
                Component: (await import('../features/orders/orders-page.js')).OrdersPage,
              }),
            },
            {
              path: '/orders/:id/invoice',
              lazy: async () => ({
                Component: (await import('../features/invoice/invoice-page.js')).InvoicePage,
              }),
            },
            {
              path: '/deliveries',
              lazy: async () => ({
                Component: (await import('../features/deliveries/deliveries-page.js'))
                  .DeliveriesPage,
              }),
            },
          ],
        },
      ],
    },
    { path: '*', element: <NotFound />, errorElement: <RouteError /> },
  ]);
}
