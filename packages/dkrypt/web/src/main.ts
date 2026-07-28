import { mount } from 'svelte';
import App from '#App.svelte';
import '#app.css';

const target = document.getElementById('app-root')!;
target.replaceChildren();
const app = mount(App, { target });

export default app;
