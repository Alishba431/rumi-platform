import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth, portal } from '../services/api';
import type { User } from '../types/portal';

const SESSION_NOT_KEPT =
  "Your password was accepted, but the sign-in didn't stick on this device. Please try again, or ask your administrator to allow sign-in from the app.";

export const useAuth = () => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    checkAuth();
  }, []);

  // Resolves true when a session exists.
  const checkAuth = async () => {
    try {
      // Try to get dashboard data - if successful, user is authenticated
      const data = await portal.getDashboard();
      setUser(data.user);
      return true;
    } catch (error) {
      setUser(null);
      return false;
    } finally {
      setLoading(false);
    }
  };

  const login = async (phoneNumber: string, password: string) => {
    try {
      const response = await auth.login(phoneNumber, password);
      if (response.success) {
        // The password can be right while the session cookie is not kept (an
        // app on a server without PORTAL_APP_ENABLED, or a blocked cookie).
        if (!(await checkAuth())) return { success: false, error: SESSION_NOT_KEPT };
        return { success: true };
      }
      return { success: false, error: response.error || 'Login failed' };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.response?.data?.error || 'Login failed. Please try again.' 
      };
    }
  };

  const logout = async () => {
    try {
      await auth.logout();
      setUser(null);
      navigate('/portal/login');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const setupPortal = async (token: string, password: string) => {
    try {
      const response = await auth.setup(token, password);
      if (response.success) {
        // The password can be right while the session cookie is not kept (an
        // app on a server without PORTAL_APP_ENABLED, or a blocked cookie).
        if (!(await checkAuth())) return { success: false, error: SESSION_NOT_KEPT };
        return { success: true };
      }
      return { success: false, error: response.error || 'Setup failed' };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.response?.data?.error || 'Setup failed. Please try again.' 
      };
    }
  };

  return {
    user,
    loading,
    login,
    logout,
    setupPortal,
    checkAuth
  };
};
