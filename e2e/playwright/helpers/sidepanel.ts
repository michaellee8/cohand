import type { Page } from '@playwright/test';

/**
 * Page Object Model for the Cohand side panel.
 * Provides helpers for navigating tabs, interacting with UI elements,
 * and reading side panel state.
 */
export class SidePanel {
  constructor(private page: Page) {}

  // ── Tab Navigation ──────────────────────────────────────────────────

  /** Click the Chat tab */
  async navigateToChat(): Promise<void> {
    await this.page.click('[data-tab="chat"], button:has-text("Chat")');
  }

  /** Click the Tasks tab */
  async navigateToTasks(): Promise<void> {
    await this.page.click('[data-tab="tasks"], button:has-text("Tasks")');
  }

  /** Click the Settings gear icon */
  async openSettings(): Promise<void> {
    await this.page.click('[data-action="settings"], button[aria-label*="settings" i], button:has-text("Settings")');
  }

  /** Get the currently active tab name */
  async getActiveTab(): Promise<string> {
    // Look for active/selected tab indicator
    const active = this.page.locator('[data-tab][aria-selected="true"], [data-tab].active, button[class*="active"]');
    const count = await active.count();
    if (count > 0) {
      return (await active.first().textContent())?.trim().toLowerCase() ?? '';
    }
    return '';
  }

  // ── UI Interaction ──────────────────────────────────────────────────

  /** Click a button by its text */
  async clickButton(text: string): Promise<void> {
    await this.page.click(`button:has-text("${text}")`);
  }

  /** Wait for text to appear in the side panel */
  async waitForText(text: string, timeout = 10_000): Promise<void> {
    await this.page.getByText(text).first().waitFor({ timeout });
  }

  /** Check if the side panel root is rendered */
  async isRendered(): Promise<boolean> {
    const root = this.page.locator('#root');
    return (await root.count()) > 0;
  }

  /** Get all visible task cards */
  async getTaskCards(): Promise<string[]> {
    const cards = this.page.locator('[data-testid="task-card"], .task-card, [class*="TaskCard"]');
    const count = await cards.count();
    const titles: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await cards.nth(i).textContent();
      if (text) titles.push(text.trim());
    }
    return titles;
  }

  /** Get the page object for direct Playwright operations */
  get raw(): Page {
    return this.page;
  }
}
