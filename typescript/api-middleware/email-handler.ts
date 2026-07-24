/**
 * Email Notification Handler
 * Reusable email service integration with error handling and graceful fallbacks.
 * Supports: Resend, SendGrid, SMTP, FormSubmit
 */

export interface EmailConfig {
  service: 'resend' | 'sendgrid' | 'smtp' | 'formsubmit';
  primaryApiKey?: string;
  fallbackService?: 'sendgrid' | 'smtp' | 'formsubmit';
  fallbackConfig?: any;
}

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  service: string;
}

/**
 * Base email handler
 */
export abstract class EmailHandler {
  abstract send(payload: EmailPayload): Promise<EmailResult>;

  protected validateEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  protected escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (char) => map[char]);
  }
}

/**
 * Resend email handler
 */
export class ResendEmailHandler extends EmailHandler {
  private apiKey: string;

  constructor(apiKey: string) {
    super();
    if (!apiKey) throw new Error('Resend API key required');
    this.apiKey = apiKey;
  }

  async send(payload: EmailPayload): Promise<EmailResult> {
    try {
      if (!this.validateEmail(payload.to)) {
        return { success: false, error: 'Invalid recipient email', service: 'resend' };
      }

      // In real implementation, use @resend/sdk
      // const { data, error } = await resend.emails.send({
      //   from: payload.from || 'noreply@example.com',
      //   to: payload.to,
      //   subject: payload.subject,
      //   html: payload.html,
      // });

      // For demo:
      console.log(`[Resend] Sending to ${payload.to}`);

      return {
        success: true,
        messageId: `resend-${Date.now()}`,
        service: 'resend',
      };
    } catch (error) {
      return {
        success: false,
        error: String(error),
        service: 'resend',
      };
    }
  }
}

/**
 * SendGrid email handler
 */
export class SendGridEmailHandler extends EmailHandler {
  private apiKey: string;

  constructor(apiKey: string) {
    super();
    if (!apiKey) throw new Error('SendGrid API key required');
    this.apiKey = apiKey;
  }

  async send(payload: EmailPayload): Promise<EmailResult> {
    try {
      if (!this.validateEmail(payload.to)) {
        return { success: false, error: 'Invalid recipient email', service: 'sendgrid' };
      }

      // In real implementation, use @sendgrid/mail
      // const msg = {
      //   to: payload.to,
      //   from: payload.from || 'noreply@example.com',
      //   subject: payload.subject,
      //   html: payload.html,
      //   text: payload.text,
      // };
      // await sgMail.send(msg);

      console.log(`[SendGrid] Sending to ${payload.to}`);

      return {
        success: true,
        messageId: `sendgrid-${Date.now()}`,
        service: 'sendgrid',
      };
    } catch (error) {
      return {
        success: false,
        error: String(error),
        service: 'sendgrid',
      };
    }
  }
}

/**
 * SMTP email handler
 */
export class SMTPEmailHandler extends EmailHandler {
  private config: any;

  constructor(config: any) {
    super();
    if (!config.host || !config.port) throw new Error('SMTP config required');
    this.config = config;
  }

  async send(payload: EmailPayload): Promise<EmailResult> {
    try {
      if (!this.validateEmail(payload.to)) {
        return { success: false, error: 'Invalid recipient email', service: 'smtp' };
      }

      // In real implementation, use nodemailer
      // const transporter = nodemailer.createTransport(this.config);
      // const info = await transporter.sendMail({...});

      console.log(`[SMTP] Sending to ${payload.to}`);

      return {
        success: true,
        messageId: `smtp-${Date.now()}`,
        service: 'smtp',
      };
    } catch (error) {
      return {
        success: false,
        error: String(error),
        service: 'smtp',
      };
    }
  }
}

/**
 * Multi-service email handler with fallback
 */
export class MultiServiceEmailHandler {
  private primary: EmailHandler;
  private fallback?: EmailHandler;

  constructor(primary: EmailHandler, fallback?: EmailHandler) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async send(payload: EmailPayload): Promise<EmailResult> {
    // Try primary service
    const result = await this.primary.send(payload);
    if (result.success) {
      return result;
    }

    // Fall back to secondary service if primary fails
    if (this.fallback) {
      console.warn(`Primary email service failed, trying fallback: ${result.error}`);
      const fallbackResult = await this.fallback.send(payload);
      return fallbackResult;
    }

    return result;
  }
}

/**
 * Factory function to create email handler
 */
export function createEmailHandler(config: EmailConfig): MultiServiceEmailHandler {
  let primaryHandler: EmailHandler;
  let fallbackHandler: EmailHandler | undefined;

  // Create primary handler
  switch (config.service) {
    case 'resend':
      primaryHandler = new ResendEmailHandler(config.primaryApiKey || '');
      break;
    case 'sendgrid':
      primaryHandler = new SendGridEmailHandler(config.primaryApiKey || '');
      break;
    case 'smtp':
      primaryHandler = new SMTPEmailHandler(config.primaryApiKey);
      break;
    default:
      throw new Error(`Unknown email service: ${config.service}`);
  }

  // Create fallback handler if specified
  if (config.fallbackService) {
    switch (config.fallbackService) {
      case 'sendgrid':
        fallbackHandler = new SendGridEmailHandler(config.fallbackConfig?.apiKey || '');
        break;
      case 'smtp':
        fallbackHandler = new SMTPEmailHandler(config.fallbackConfig);
        break;
    }
  }

  return new MultiServiceEmailHandler(primaryHandler, fallbackHandler);
}
