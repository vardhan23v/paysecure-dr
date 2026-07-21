import { useRoutes } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Runbooks from './pages/Runbooks';
import RunbookDetail from './components/RunbookDetail';
import Architecture from './pages/Architecture';
import Status from './pages/Status';
import Compliance from './pages/Compliance';
import FMEA from './pages/FMEA';

const routes = [
  { path: '/', element: <Dashboard /> },
  { path: '/architecture', element: <Architecture /> },
  { path: '/runbooks', element: <Runbooks /> },
  { path: '/runbook/:id', element: <RunbookDetail /> },
  { path: '/compliance', element: <Compliance /> },
  { path: '/fmea', element: <FMEA /> },
  { path: '/status', element: <Status /> },
];

export default function App() {
  const element = useRoutes(routes);
  return <Layout>{element}</Layout>;
}