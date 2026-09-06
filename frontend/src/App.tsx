import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AuthPage } from "./pages/AuthPage";
import { BoardPage } from "./pages/BoardPage";
import { BoardsPage } from "./pages/BoardsPage";

/**
 * The boot gate. While the one refresh call is in flight we show a loading
 * state -- never flash the login page at an already-authenticated user, whose
 * session is alive in an httpOnly cookie this JavaScript cannot see.
 */
function Gate(): ReactNode {
  const { status } = useAuth();

  if (status === "booting") {
    return (
      <div className="centered-note">
        <p className="mono">Restoring your session…</p>
      </div>
    );
  }

  if (status === "anonymous") return <AuthPage />;

  return (
    <Routes>
      <Route path="/boards" element={<BoardsPage />} />
      <Route path="/boards/:boardId" element={<BoardPage />} />
      <Route path="*" element={<Navigate to="/boards" replace />} />
    </Routes>
  );
}

export function App(): ReactNode {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
