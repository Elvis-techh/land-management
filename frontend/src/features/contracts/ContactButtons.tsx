import type { ReactElement } from "react";

import { IconMail, IconMessage, IconWhatsApp } from "../../components/Icons";
import type { MoneyView } from "../../lib/money";
import type { Contract } from "../../types";
import type { ContactChannel } from "./contactCustomer";
import {
  CHANNEL_LABELS,
  CHANNEL_MISSING,
  canContact,
  contactUrl,
  defaultMessage,
  defaultSubject,
} from "./contactCustomer";

/** The three channels, in the order they are offered. */
const CHANNELS: ContactChannel[] = ["whatsapp", "sms", "email"];

const ICONS: Record<ContactChannel, () => ReactElement> = {
  whatsapp: IconWhatsApp,
  sms: IconMessage,
  email: IconMail,
};

/**
 * Write to this contract's customer: WhatsApp, SMS or email.
 *
 * Three buttons rather than one menu, because the whole value of this control
 * is that chasing a cuota is ONE press from the list. A menu would make every
 * contact two presses to save a little width on a column that already fits.
 *
 * Each is a real `<a href>` rather than a button calling `window.open`. That is
 * what gives the row a middle-click, a long-press, "copy link", and — the one
 * that matters — a working target inside a popup blocker, since the navigation
 * is the user's click rather than script the browser has to be persuaded to
 * trust. `target="_blank"` only applies to WhatsApp, which is a web page; `sms:`
 * and `mailto:` hand off to an application and must not leave a blank tab
 * behind them.
 */
export function ContactButtons({
  contract,
  money,
}: {
  contract: Contract;
  money: MoneyView;
}) {
  const message = defaultMessage(contract, money);
  const subject = defaultSubject(contract);

  return (
    <span className="contact-actions">
      {CHANNELS.map((channel) => {
        const Icon = ICONS[channel];
        const enabled = canContact(contract, channel);
        const label = `${CHANNEL_LABELS[channel]} a ${contract.customer.fullName}`;

        if (!enabled) {
          return (
            <span
              key={channel}
              className="contact-btn is-disabled"
              title={CHANNEL_MISSING[channel]}
              aria-hidden="true"
            >
              <Icon />
            </span>
          );
        }

        return (
          <a
            key={channel}
            className={`contact-btn is-${channel}`}
            href={contactUrl(contract, channel, message, subject)}
            title={label}
            aria-label={label}
            {...(channel === "whatsapp"
              ? { target: "_blank", rel: "noreferrer noopener" }
              : {})}
            /*
             * The row underneath opens the contract panel. Without this, writing
             * to somebody would also open their contract behind the message.
             */
            onClick={(event) => event.stopPropagation()}
          >
            <Icon />
          </a>
        );
      })}
    </span>
  );
}
