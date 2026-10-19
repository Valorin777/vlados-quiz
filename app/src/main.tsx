import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Route, Router, Switch } from 'wouter';
import { FALLBACK, ROUTES, locationHook } from './router';
// The design system (fonts, tokens, primitives) first, then the page shell.
import './visual/styles.css';
import './app.css';

function Boot() {
  return (
    <div className="app-boot" role="status">
      <i aria-hidden="true" />
      <span>загружаем…</span>
    </div>
  );
}

function App() {
  return (
    <Router hook={locationHook}>
      <Suspense fallback={<Boot />}>
        <Switch>
          {ROUTES.map((r) => (
            <Route key={r.path} path={r.path} nest={r.nest} component={r.component} />
          ))}
          <Route component={FALLBACK} />
        </Switch>
      </Suspense>
    </Router>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
