import { Navigate, Route, Routes } from 'react-router-dom';
import { CallbackPage } from './features/auth/CallbackPage';
import { LoginPage } from './features/auth/LoginPage';
import { RequireAuth } from './features/auth/RequireAuth';
import { DashboardPage } from './features/extractions/DashboardPage';
import { ExtractionPage } from './features/extractions/ExtractionPage';
import { HistoryPage } from './features/extractions/HistoryPage';
import { AiConnectionsPage } from './features/ai-connections/AiConnectionsPage';
import { PromptWizardPage } from './features/prompt-generation/PromptWizardPage';
import { PromptWorkspacePage } from './features/prompt-generation/PromptWorkspacePage';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/callback" element={<CallbackPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <DashboardPage />
          </RequireAuth>
        }
      />
      <Route
        path="/history"
        element={
          <RequireAuth>
            <HistoryPage />
          </RequireAuth>
        }
      />
      <Route
        path="/extractions/:id"
        element={
          <RequireAuth>
            <ExtractionPage />
          </RequireAuth>
        }
      />
      <Route
        path="/settings/ai-connections"
        element={
          <RequireAuth>
            <AiConnectionsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/extractions/:id/prompts/new"
        element={
          <RequireAuth>
            <PromptWizardPage />
          </RequireAuth>
        }
      />
      <Route
        path="/prompt-projects/:id"
        element={
          <RequireAuth>
            <PromptWorkspacePage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
