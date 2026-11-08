import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

export const SERVICE_ACCOUNT_EMAIL =
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
  'ais-gemini-key-2d1c5a154f6c46f@718641806689.iam.gserviceaccount.com';

const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const SERVICE_ACCOUNT_PRIVATE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  // If a Google Service Account Private Key is provided alongside Domain-Wide Delegation, use OAuth2 2LO
  if (SERVICE_ACCOUNT_PRIVATE_KEY && SERVICE_ACCOUNT_PRIVATE_KEY.includes('BEGIN PRIVATE KEY')) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        type: 'OAuth2',
        user: EMAIL_USER,
        serviceClient: SERVICE_ACCOUNT_EMAIL,
        privateKey: SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n')
      }
    });
    return transporter;
  }

  // Standard authenticated SMTP relay paired with Service Account identity metadata
  if (EMAIL_USER && EMAIL_PASS) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      pool: true,
      maxConnections: 3,
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
      }
    });
  }
  return transporter;
}

/**
 * Shared warm-paper editorial HTML email wrapper (Toss-up style)
 */
function wrapEmailTemplate({ badgeText, badgeColor = '#E85A4F', title, subtitle, bodyHtml, footerNote }) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#EAE6DC;font-family:'Be Vietnam Pro',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1F1B16;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#EAE6DC;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#FBF8F0;border:2px solid #1F1B16;border-radius:18px;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="padding:24px 28px;border-bottom:1.5px solid #E2DDD0;background-color:#F5F1E8;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="display:inline-block;width:30px;height:30px;line-height:30px;text-align:center;background-color:#1F1B16;color:#FBF8F0;font-weight:800;font-size:15px;border-radius:8px;margin-right:8px;">M</span>
                    <span style="font-size:18px;font-weight:800;letter-spacing:-0.4px;color:#1F1B16;vertical-align:middle;">Meet up</span>
                  </td>
                  <td align="right">
                    <span style="display:inline-block;padding:5px 12px;border-radius:999px;background-color:${badgeColor};color:#FBF8F0;font-size:11px;font-weight:700;letter-spacing:0.2px;">${badgeText}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Main Content -->
          <tr>
            <td style="padding:32px 28px;">
              <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;letter-spacing:-0.5px;color:#1F1B16;line-height:1.2;">${title}</h1>
              <p style="margin:0 0 24px;font-size:14px;color:#6E665B;line-height:1.5;">${subtitle}</p>
              ${bodyHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:18px 28px;background-color:#F5F1E8;border-top:1.5px solid #E2DDD0;text-align:center;">
              <p style="margin:0;font-size:12px;color:#6E665B;font-weight:500;">${footerNote || 'Hệ thống hỗ trợ đặt lịch nhóm & nhắc hẹn định kỳ Meet up'}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * 1. Send Account Registration OTP Email
 */
export async function sendRegisterOtpEmail({ email, name, otp, supabaseActionLink }) {
  const html = wrapEmailTemplate({
    badgeText: 'Xác nhận tài khoản',
    badgeColor: '#3D7A5A',
    title: `Xin chào ${name || email.split('@')[0]}, xác nhận tài khoản Meet up`,
    subtitle: 'Nhập mã OTP bên dưới để kích hoạt tài khoản và bắt đầu kéo thả lịch rảnh hàng tuần cùng nhóm của bạn.',
    bodyHtml: `
      <div style="background-color:#F5F1E8;border:1.5px solid #1F1B16;border-radius:14px;padding:22px;text-align:center;margin-bottom:20px;">
        <div style="font-size:12px;font-weight:700;color:#6E665B;margin-bottom:6px;">Mã OTP kích hoạt tài khoản của bạn</div>
        <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#3D7A5A;font-variant-numeric:tabular-nums;">${otp}</div>
        <div style="font-size:12px;color:#8E867A;margin-top:8px;">Mã có hiệu lực trong vòng 10 phút</div>
      </div>
      ${
        supabaseActionLink
          ? `<div style="text-align:center;margin:18px 0;">
               <a href="${supabaseActionLink}" target="_blank" rel="noopener" style="display:inline-block;padding:11px 22px;background-color:#3D7A5A;color:#FBF8F0;text-decoration:none;font-weight:700;font-size:13px;border-radius:999px;">Bấm vào đây để xác nhận trực tiếp</a>
             </div>`
          : ''
      }
      <p style="margin:0;font-size:13px;color:#6E665B;line-height:1.6;">Nếu bạn không thực hiện yêu cầu đăng ký này, vui lòng bỏ qua email này.</p>
    `
  });

  return sendMailInternal({
    to: email,
    subject: `[Meet up] Mã OTP đăng ký tài khoản: ${otp}`,
    text: `Xin chào ${name || email},\nMã OTP đăng ký tài khoản Meet up của bạn là: ${otp} (hiệu lực 10 phút).`,
    html
  });
}

/**
 * 2. Send Password Reset OTP Email
 */
export async function sendResetPasswordOtpEmail({
  email,
  name,
  otp,
  supabaseEmailOtp,
  supabaseRecoveryLink
}) {
  const html = wrapEmailTemplate({
    badgeText: 'Khôi phục mật khẩu',
    badgeColor: '#C43D32',
    title: 'Đặt lại mật khẩu tài khoản Meet up',
    subtitle: `Xin chào ${name || email.split('@')[0]}, bạn vừa yêu cầu đặt lại mật khẩu cho tài khoản ${email}.`,
    bodyHtml: `
      <div style="background-color:#F5F1E8;border:1.5px solid #C43D32;border-radius:14px;padding:22px;text-align:center;margin-bottom:18px;">
        <div style="font-size:12px;font-weight:700;color:#6E665B;margin-bottom:6px;">Mã OTP khôi phục mật khẩu</div>
        <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#C43D32;font-variant-numeric:tabular-nums;">${otp}</div>
        <div style="font-size:12px;color:#8E867A;margin-top:8px;">Mã có hiệu lực trong vòng 10 phút</div>
      </div>
      ${
        supabaseRecoveryLink
          ? `<div style="text-align:center;margin:20px 0;">
               <a href="${supabaseRecoveryLink}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 24px;background-color:#1F1B16;color:#FBF8F0;text-decoration:none;font-weight:700;font-size:13.5px;border-radius:999px;">Bấm vào đây để đặt lại mật khẩu trực tiếp</a>
             </div>`
          : ''
      }
      <p style="margin:0;font-size:13px;color:#6E665B;line-height:1.6;">Sau khi nhập mã OTP này trên màn hình Quên mật khẩu, bạn có thể thiết lập mật khẩu mới ngay lập tức.</p>
    `
  });

  return sendMailInternal({
    to: email,
    subject: `[Meet up] Mã OTP đặt lại mật khẩu: ${otp}`,
    text: `Mã OTP đặt lại mật khẩu Meet up của bạn là: ${otp} (hiệu lực 10 phút).`,
    html
  });
}

/**
 * 3. Send Meeting Confirmed Notification Email (with 1-Click Add to Google Calendar link)
 */
export async function sendMeetingConfirmedEmail({ meeting, recipients, googleCalendarUrl }) {
  const toList = Array.isArray(recipients) && recipients.length > 0 ? recipients.join(', ') : EMAIL_USER;
  const html = wrapEmailTemplate({
    badgeText: 'Đã chốt lịch họp',
    badgeColor: '#3D7A5A',
    title: `Lịch họp đã chốt: ${meeting.title}`,
    subtitle: `Nhóm "${meeting.group_name}" đã thống nhất khung giờ họp cho tuần ${meeting.week_key}.`,
    bodyHtml: `
      <div style="background-color:#EEF5F0;border:1.5px solid #3D7A5A;border-radius:14px;padding:20px;margin-bottom:20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#1F1B16;">
          <tr>
            <td style="padding:6px 0;color:#6E665B;width:130px;">Nhóm / Crew:</td>
            <td style="padding:6px 0;font-weight:700;">${meeting.group_name}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#6E665B;">Thời gian:</td>
            <td style="padding:6px 0;font-weight:800;color:#3D7A5A;">${meeting.day_code} (${meeting.date_iso}) · ${meeting.start_time} - ${meeting.end_time}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#6E665B;">Địa điểm / Link:</td>
            <td style="padding:6px 0;font-weight:600;">${meeting.location || 'Google Meet / Phòng họp nhóm'}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#6E665B;">Người chốt:</td>
            <td style="padding:6px 0;">${meeting.confirmed_by_name} (${meeting.confirmed_by_email})</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#6E665B;">Chế độ Manager:</td>
            <td style="padding:6px 0;">${meeting.manager_matched ? 'Khớp 100% lịch Manager' : 'Khớp theo số đông nhóm'}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#6E665B;">Thành viên tham gia:</td>
            <td style="padding:6px 0;">${(meeting.attendee_names || []).join(', ')}</td>
          </tr>
        </table>
      </div>
      <div style="text-align:center;margin:24px 0 8px;">
        <a href="${googleCalendarUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 26px;background-color:#1F1B16;color:#FBF8F0;text-decoration:none;font-weight:800;font-size:14px;border-radius:999px;">+ Thêm vào Google Calendar</a>
      </div>
    `
  });

  return sendMailInternal({
    to: toList,
    subject: `[Meet up] Đã chốt lịch: ${meeting.title} (${meeting.day_code} ${meeting.start_time}-${meeting.end_time})`,
    text: `Lịch họp "${meeting.title}" của nhóm ${meeting.group_name} đã được chốt vào ${meeting.day_code} (${meeting.date_iso}) lúc ${meeting.start_time}-${meeting.end_time} tại ${meeting.location}.\nThêm vào Google Calendar: ${googleCalendarUrl}`,
    html
  });
}

/**
 * 4. Send Upcoming Meeting Reminder Email
 */
export async function sendMeetingReminderEmail({ meeting, recipients, googleCalendarUrl, minutesUntil }) {
  const toList = Array.isArray(recipients) && recipients.length > 0 ? recipients.join(', ') : EMAIL_USER;
  const timeText = minutesUntil
    ? `Sắp diễn ra trong khoảng ${minutesUntil} phút nữa`
    : 'Nhắc nhở lịch họp sắp tới của nhóm';
  const html = wrapEmailTemplate({
    badgeText: 'Nhắc nhở cuộc họp',
    badgeColor: '#D97724',
    title: `Nhắc hẹn: ${meeting.title}`,
    subtitle: `${timeText}. Đừng quên tham gia đúng giờ cùng các thành viên trong nhóm "${meeting.group_name}".`,
    bodyHtml: `
      <div style="background-color:#FDF6EC;border:1.5px solid #D97724;border-radius:14px;padding:20px;margin-bottom:20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#1F1B16;">
          <tr>
            <td style="padding:6px 0;color:#6E665B;width:130px;">Cuộc họp:</td>
            <td style="padding:6px 0;font-weight:800;">${meeting.title}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#6E665B;">Nhóm:</td>
            <td style="padding:6px 0;font-weight:700;">${meeting.group_name}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#6E665B;">Khung giờ:</td>
            <td style="padding:6px 0;font-weight:800;color:#D97724;">${meeting.day_code} (${meeting.date_iso}) · ${meeting.start_time} - ${meeting.end_time}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#6E665B;">Địa điểm:</td>
            <td style="padding:6px 0;font-weight:600;">${meeting.location || 'Google Meet / Phòng họp nhóm'}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#6E665B;">Thành viên:</td>
            <td style="padding:6px 0;">${(meeting.attendee_names || []).join(', ')}</td>
          </tr>
        </table>
      </div>
      <div style="text-align:center;margin:24px 0 8px;">
        <a href="${googleCalendarUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 26px;background-color:#1F1B16;color:#FBF8F0;text-decoration:none;font-weight:800;font-size:14px;border-radius:999px;">Mở Google Calendar</a>
      </div>
    `
  });

  return sendMailInternal({
    to: toList,
    subject: `[Meet up] Sắp tới giờ họp: ${meeting.title} (${meeting.start_time})`,
    text: `Nhắc nhở: Cuộc họp "${meeting.title}" (${meeting.group_name}) sẽ diễn ra vào ${meeting.day_code} ${meeting.date_iso} lúc ${meeting.start_time}-${meeting.end_time} tại ${meeting.location}.`,
    html
  });
}

/**
 * 5. Send Group Invitation Email (Recipient must accept before being added to group)
 */
export async function sendGroupInvitationEmail({
  recipientEmail,
  inviterName,
  inviterEmail,
  groupName,
  groupDescription,
  inviteToken,
  appBaseUrl = 'http://localhost:3005'
}) {
  const acceptUrl = `${appBaseUrl}/api/invitations/respond?token=${encodeURIComponent(inviteToken)}&action=accept`;
  const declineUrl = `${appBaseUrl}/api/invitations/respond?token=${encodeURIComponent(inviteToken)}&action=decline`;

  const html = wrapEmailTemplate({
    badgeText: 'Lời mời tham gia nhóm',
    badgeColor: '#3D7A5A',
    title: `${inviterName} mời bạn vào nhóm "${groupName}"`,
    subtitle: `Bạn nhận được lời mời tham gia nhóm họp định kỳ trên Meet up từ ${inviterName} (${inviterEmail}). Khi bạn đồng ý, bạn sẽ được thêm vào nhóm để cùng kéo thả lịch rảnh hàng tuần.`,
    bodyHtml: `
      <div style="background-color:#EEF5F0;border:1.5px solid #3D7A5A;border-radius:14px;padding:20px;margin-bottom:22px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#1F1B16;">
          <tr>
            <td style="padding:6px 0;color:#6E665B;width:120px;">Tên nhóm:</td>
            <td style="padding:6px 0;font-weight:800;font-size:15px;">${groupName}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#6E665B;">Người mời:</td>
            <td style="padding:6px 0;font-weight:700;">${inviterName} (${inviterEmail})</td>
          </tr>
          ${
            groupDescription
              ? `<tr>
                   <td style="padding:6px 0;color:#6E665B;">Mô tả:</td>
                   <td style="padding:6px 0;">${groupDescription}</td>
                 </tr>`
              : ''
          }
        </table>
      </div>
      <div style="text-align:center;margin:24px 0 14px;">
        <a href="${acceptUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 26px;background-color:#3D7A5A;color:#FBF8F0;text-decoration:none;font-weight:800;font-size:14px;border-radius:999px;margin:4px 6px;">Đồng ý tham gia nhóm</a>
        <a href="${declineUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 22px;background-color:#F5F1E8;color:#6E665B;border:1.5px solid #D5CFC2;text-decoration:none;font-weight:700;font-size:13.5px;border-radius:999px;margin:4px 6px;">Từ chối</a>
      </div>
      <p style="margin:12px 0 0;font-size:12.5px;color:#6E665B;line-height:1.5;text-align:center;">
        Bạn cũng có thể đăng nhập trực tiếp vào ứng dụng Meet up bằng địa chỉ email <strong>${recipientEmail}</strong> để xem và bấm Đồng ý lời mời.
      </p>
    `
  });

  return sendMailInternal({
    to: recipientEmail,
    subject: `[Meet up] ${inviterName} mời bạn tham gia nhóm "${groupName}"`,
    text: `${inviterName} (${inviterEmail}) mời bạn tham gia nhóm "${groupName}" trên Meet up.\nBấm vào liên kết sau để Đồng ý tham gia: ${acceptUrl}\nHoặc Từ chối: ${declineUrl}`,
    html
  });
}

async function sendMailInternal({ to, subject, text, html }) {
  const mailer = getTransporter();
  if (!mailer) {
    return { sent: false, simulated: true, reason: 'No SMTP transporter configured', serviceAccount: SERVICE_ACCOUNT_EMAIL };
  }
  try {
    const info = await mailer.sendMail({
      from: `"Meet up" <${EMAIL_USER}>`,
      replyTo: EMAIL_USER,
      headers: {
        'X-Google-Service-Account': SERVICE_ACCOUNT_EMAIL,
        'X-Supabase-Project': 'cbizvzvbdkykcrydckwi'
      },
      to,
      subject,
      text,
      html
    });
    return {
      sent: true,
      messageId: info.messageId,
      sender: EMAIL_USER,
      serviceAccount: SERVICE_ACCOUNT_EMAIL
    };
  } catch (err) {
    console.error('[EmailService] Error sending email:', err.message);
    return {
      sent: false,
      error: err.message,
      sender: EMAIL_USER,
      serviceAccount: SERVICE_ACCOUNT_EMAIL
    };
  }
}

/**
 * Helper to generate 1-click Google Calendar Template URL
 */
export function buildGoogleCalendarUrl(meeting) {
  const dateClean = (meeting.date_iso || '2026-11-11').replace(/-/g, '');
  const startClean = (meeting.start_time || '19:30').replace(':', '') + '00';
  const endClean = (meeting.end_time || '21:00').replace(':', '') + '00';
  const dates = `${dateClean}T${startClean}/${dateClean}T${endClean}`;

  const details = [
    `Nhóm định kỳ: ${meeting.group_name}`,
    `Tuần: ${meeting.week_key}`,
    `Người chốt lịch: ${meeting.confirmed_by_name} (${meeting.confirmed_by_email})`,
    `Thành viên tham gia: ${(meeting.attendee_names || []).join(', ')}`,
    meeting.notes ? `Ghi chú: ${meeting.notes}` : ''
  ].filter(Boolean).join('\n');

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `[Meet up] ${meeting.title}`,
    dates,
    details,
    location: meeting.location || 'Online / Studio',
    ctz: 'Asia/Ho_Chi_Minh'
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
