import { Link, Route, Routes } from 'react-router';
import { EmptyState } from './components/common.tsx';
import { Layout } from './components/Layout.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { ImportPage } from './pages/ImportPage.tsx';
import { Receipts } from './pages/Receipts.tsx';
import { Rules } from './pages/Rules.tsx';
import { Transactions } from './pages/Transactions.tsx';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="receipts" element={<Receipts />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="rules" element={<Rules />} />
        <Route
          path="*"
          element={
            <EmptyState title="Page not found" action={<Link className="btn primary" to="/">Back to the dashboard</Link>}>
              There is nothing at this address.
            </EmptyState>
          }
        />
      </Route>
    </Routes>
  );
}
