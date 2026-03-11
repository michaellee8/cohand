import type { Page } from '@playwright/test';

/**
 * Helpers for interacting with the Create Task Wizard (CreateTaskWizard component).
 */
export class WizardHelper {
  constructor(private page: Page) {}

  /** Open the wizard by clicking the "New Task" / "Create" button */
  async startWizard(): Promise<void> {
    await this.page.click('button:has-text("New Task"), button:has-text("Create"), button:has-text("Add Task"), [data-action="new-task"]');
  }

  /** Fill the task description field */
  async fillDescription(text: string): Promise<void> {
    const input = this.page.locator('textarea, input[type="text"]').first();
    await input.fill(text);
  }

  /** Add a domain to the allowed domains list */
  async addDomain(domain: string): Promise<void> {
    const domainInput = this.page.locator('input[placeholder*="domain" i], input[name*="domain" i], input[placeholder*="url" i]');
    await domainInput.fill(domain);
    // Press Enter or click add button
    const addBtn = this.page.locator('button:has-text("Add"), button[aria-label*="add" i]');
    if (await addBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await addBtn.click();
    } else {
      await domainInput.press('Enter');
    }
  }

  /** Click the "Next" button */
  async clickNext(): Promise<void> {
    await this.page.click('button:has-text("Next"), button:has-text("Continue")');
  }

  /** Click the "Back" button */
  async clickBack(): Promise<void> {
    await this.page.click('button:has-text("Back"), button:has-text("Previous")');
  }

  /** Get the current step label or index */
  async getCurrentStep(): Promise<string> {
    // Try to find a step indicator
    const stepIndicator = this.page.locator('[data-step], [class*="step" i][class*="active" i], [aria-current="step"]');
    if (await stepIndicator.count() > 0) {
      return (await stepIndicator.first().textContent())?.trim() ?? '';
    }
    // Fallback: look for step text
    const stepText = this.page.locator('text=/Step \\d/i');
    if (await stepText.count() > 0) {
      return (await stepText.first().textContent())?.trim() ?? '';
    }
    return '';
  }

  /** Submit / finish the wizard */
  async submit(): Promise<void> {
    await this.page.click('button:has-text("Create"), button:has-text("Save"), button:has-text("Done"), button[type="submit"]');
  }
}
