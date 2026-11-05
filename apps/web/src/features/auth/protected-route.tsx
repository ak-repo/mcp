import { Navigate, Outlet } from 'react-router';
import { useAuth } from '../../lib/api/auth-store.js';
export function ProtectedRoute() {
  return useAuth().authenticated ? <Outlet /> : <Navigate to="/login" replace />;
}
