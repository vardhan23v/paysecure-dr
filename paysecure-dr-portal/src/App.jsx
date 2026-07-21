import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Runbooks from './pages/Runbooks';
import RunbookDetail from './components/RunbookDetail';
import Architecture from './pages/Architecture';
import Status from './pages/Status';
import Compliance from './pages/Compliance';
import FMEA from './pages/FMEA';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/architecture" element={<Architecture />} />
        <Route path="/runbooks" element={<Runbooks />} />
        <Route path="/runbook/:id" element={<RunbookDetail />} />
        <Route path="/compliance" element={<Compliance />} />
        <Route path="/fmea" element={<FMEA />} />
        <Route path="/status" element={<Status />} />
      </Routes>
    </Layout>
  );
}