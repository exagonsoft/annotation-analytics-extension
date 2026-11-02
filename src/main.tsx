import React, { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { console.error('Annotation Analytics interface failed. Reload the extension page.'); }
  render() {
    return this.state.failed ? <div role="alert" className="empty"><h1>Unable to display analytics</h1><p>Your local records are retained. Reload this page. If the problem persists, open extension errors in chrome://extensions.</p><button onClick={() => location.reload()}>Reload</button></div> : this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
