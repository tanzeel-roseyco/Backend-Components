/**
 * Contact Form Handler
 * Multi-channel contact form processor with persistence and notifications.
 */

import { z } from 'zod';

export const ContactFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  email: z.string().email('Invalid email address'),
  subject: z.string().min(1).max(255).optional(),
  message: z.string().min(1, 'Message is required').max(5000),
  phone: z.string().max(20).optional(),
});

export type ContactFormData = z.infer<typeof ContactFormSchema>;

export interface ContactFormConfig {
  storageBackend: 'supabase' | 'postgres' | 'dynamodb';
  emailService: any; // EmailHandler instance
  adminEmail: string;
  preventDuplicates?: boolean;
  duplicateWindow?: number; // milliseconds
}

export class ContactFormHandler {
  private config: ContactFormConfig;

  constructor(config: ContactFormConfig) {
    this.config = config;
  }

  /**
   * Process contact form submission
   */
  async handle(payload: any): Promise<{ success: boolean; id?: string; error?: string }> {
    try {
      // Validate input
      const validation = ContactFormSchema.safeParse(payload);
      if (!validation.success) {
        return {
          success: false,
          error: `Validation failed: ${validation.error.errors[0].message}`,
        };
      }

      const data = validation.data;

      // Check for duplicates if enabled
      if (this.config.preventDuplicates) {
        const isDuplicate = await this.checkDuplicate(data.email);
        if (isDuplicate) {
          // Return success even if duplicate (prevent enumeration)
          return { success: true, id: `duplicate-${Date.now()}` };
        }
      }

      // Store in database
      const storedId = await this.storeContact(data);
      if (!storedId) {
        return { success: false, error: 'Failed to store contact' };
      }

      // Send notification email
      const emailSent = await this.sendNotification(data);
      if (!emailSent) {
        console.error('Failed to send notification email, but contact stored');
      }

      return { success: true, id: storedId };
    } catch (error) {
      console.error('Contact form error:', error);
      return { success: false, error: 'An error occurred' };
    }
  }

  /**
   * Check if email already submitted recently
   */
  private async checkDuplicate(email: string): Promise<boolean> {
    const window = this.config.duplicateWindow || 24 * 60 * 60 * 1000; // 24 hours default
    const cutoff = Date.now() - window;

    // TODO: Query database for recent submission from this email
    // const existing = await db.contacts.findOne({
    //   email,
    //   createdAt: { $gte: new Date(cutoff) }
    // });

    return false; // For demo
  }

  /**
   * Store contact in database
   */
  private async storeContact(data: ContactFormData): Promise<string | null> {
    try {
      const id = `contact-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const record = {
        id,
        name: data.name,
        email: data.email,
        subject: data.subject || 'Contact Form Submission',
        message: data.message,
        phone: data.phone,
        createdAt: new Date(),
        status: 'new',
      };

      // TODO: Store in actual database
      // switch (this.config.storageBackend) {
      //   case 'supabase':
      //     await supabase.from('contacts').insert([record]);
      //     break;
      //   case 'postgres':
      //     await db.insert(contacts).values(record);
      //     break;
      // }

      console.log('Contact stored:', id);
      return id;
    } catch (error) {
      console.error('Storage error:', error);
      return null;
    }
  }

  /**
   * Send admin notification email
   */
  private async sendNotification(data: ContactFormData): Promise<boolean> {
    try {
      const html = `
        <h2>New Contact Form Submission</h2>
        <p><strong>Name:</strong> ${this.escapeHtml(data.name)}</p>
        <p><strong>Email:</strong> ${this.escapeHtml(data.email)}</p>
        ${data.phone ? `<p><strong>Phone:</strong> ${this.escapeHtml(data.phone)}</p>` : ''}
        ${data.subject ? `<p><strong>Subject:</strong> ${this.escapeHtml(data.subject)}</p>` : ''}
        <p><strong>Message:</strong></p>
        <pre>${this.escapeHtml(data.message)}</pre>
      `;

      const result = await this.config.emailService.send({
        to: this.config.adminEmail,
        subject: `New Contact: ${data.name}`,
        html,
        replyTo: data.email,
      });

      return result.success;
    } catch (error) {
      console.error('Notification email error:', error);
      return false;
    }
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
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
