import { render } from 'preact';

import { App } from './app';
import './styles.css';

/** 挂载应用根组件。 */
function bootstrap(): void {
  const root = document.getElementById('app');
  if (!root) {
    throw new Error('找不到应用挂载节点。');
  }

  render(<App />, root);
}

bootstrap();
