import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'Inter, sans-serif', flexDirection: 'column', gap: 12, color: '#888', fontSize: 14 }}>
          <div style={{ fontSize: 32 }}>⚠</div>
          <div style={{ fontWeight: 600, color: '#333', fontSize: 16 }}>Something went wrong</div>
          <div style={{ maxWidth: 420, textAlign: 'center', lineHeight: 1.5 }}>{this.state.error.message}</div>
          <button style={{ marginTop: 8, padding: '8px 20px', cursor: 'pointer', borderRadius: 6, border: '1px solid #ddd', background: '#fff' }} onClick={() => window.location.reload()}>Reload page</button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
