import { Inject, Injectable } from '@nestjs/common';
import { MAXIMUM_COST_MINOR } from '@extractionstack/shared';
import { CREDITS_REPOSITORY, type CreditsRepositoryPort } from './credits.repository.js';

const MAX_ID_LENGTH = 191;
const MAX_IDEMPOTENCY_KEY_LENGTH = 120;
const MAX_REASON_LENGTH = 500;

export interface CreditReservation {
  id: string;
  ownerId: string;
  jobId: string;
  amountMinor: string;
  maximumAcceptedAmountMinor: string;
  createdAt: string;
}

export interface ReserveCredits {
  ownerId: string;
  jobId: string;
  amountMinor: bigint;
  maximumAcceptedAmountMinor?: bigint;
  idempotencyKey: string;
}

export interface ConfirmCredits {
  reservationId: string;
  actualAmountMinor: bigint;
}

export interface ReverseCredits {
  reservationId: string;
  reason: string;
}

export interface CreditsPort {
  reserve(command: ReserveCredits): Promise<CreditReservation>;
  confirm(command: ConfirmCredits): Promise<void>;
  reverse(command: ReverseCredits): Promise<void>;
}

@Injectable()
export class CreditsService implements CreditsPort {
  constructor(@Inject(CREDITS_REPOSITORY) private readonly repository: CreditsRepositoryPort) {}

  reserve(command: ReserveCredits): Promise<CreditReservation>;
  reserve(
    ownerId: string,
    jobId: string,
    amountMinor: bigint,
    idempotencyKey: string,
    maximumAcceptedAmountMinor?: bigint,
  ): Promise<CreditReservation>;
  async reserve(
    ownerOrCommand: string | ReserveCredits,
    jobId?: string,
    amountMinor?: bigint,
    idempotencyKey?: string,
    maximumAcceptedAmountMinor?: bigint,
  ): Promise<CreditReservation> {
    const command =
      typeof ownerOrCommand === 'string'
        ? {
            ownerId: ownerOrCommand,
            jobId: jobId ?? '',
            amountMinor: amountMinor ?? 0n,
            idempotencyKey: idempotencyKey ?? '',
            maximumAcceptedAmountMinor,
          }
        : ownerOrCommand;
    const acceptedMaximum = command.maximumAcceptedAmountMinor ?? command.amountMinor;

    const { ownerId } = command;
    jobId = command.jobId;
    amountMinor = command.amountMinor;
    idempotencyKey = command.idempotencyKey;
    assertIdentifier(ownerId);
    assertIdentifier(jobId);
    assertText(idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
    assertAmount(amountMinor, false);
    assertAmount(acceptedMaximum, false);
    if (acceptedMaximum < amountMinor) throw new Error('CREDIT_AMOUNT_INVALID');

    const reservation = await this.repository.reserve({
      ownerId,
      jobId,
      amountMinor,
      maximumAcceptedAmountMinor: acceptedMaximum,
      idempotencyKey,
    });
    return {
      id: reservation.id,
      ownerId: reservation.ownerId,
      jobId: reservation.jobId,
      amountMinor: reservation.amountMinor.toString(),
      maximumAcceptedAmountMinor: reservation.maximumAcceptedAmountMinor.toString(),
      createdAt: reservation.createdAt.toISOString(),
    };
  }

  confirm(command: ConfirmCredits): Promise<void>;
  confirm(reservationId: string, actualAmountMinor: bigint): Promise<void>;
  async confirm(
    reservationOrCommand: string | ConfirmCredits,
    actualAmountMinor?: bigint,
  ): Promise<void> {
    const reservationId =
      typeof reservationOrCommand === 'string'
        ? reservationOrCommand
        : reservationOrCommand.reservationId;
    actualAmountMinor =
      typeof reservationOrCommand === 'string'
        ? (actualAmountMinor ?? -1n)
        : reservationOrCommand.actualAmountMinor;
    assertIdentifier(reservationId);
    assertAmount(actualAmountMinor, true);
    await this.repository.confirm(reservationId, actualAmountMinor);
  }

  reverse(command: ReverseCredits): Promise<void>;
  reverse(reservationId: string, reason: string): Promise<void>;
  async reverse(reservationOrCommand: string | ReverseCredits, reason?: string): Promise<void> {
    const reservationId =
      typeof reservationOrCommand === 'string'
        ? reservationOrCommand
        : reservationOrCommand.reservationId;
    reason =
      typeof reservationOrCommand === 'string' ? (reason ?? '') : reservationOrCommand.reason;
    assertIdentifier(reservationId);
    assertText(reason, MAX_REASON_LENGTH);
    await this.repository.reverse(reservationId, reason);
  }

  async getAvailableBalance(ownerId: string): Promise<string> {
    assertIdentifier(ownerId);
    return (await this.repository.getAvailableBalance(ownerId)).toString();
  }
}

function assertIdentifier(value: string): void {
  assertText(value, MAX_ID_LENGTH);
}

function assertText(value: string, maxLength: number): void {
  if (value.length === 0 || value.length > maxLength || value.trim() !== value) {
    throw new Error('CREDIT_COMMAND_INVALID');
  }
}

function assertAmount(value: bigint, allowZero: boolean): void {
  if (
    typeof value !== 'bigint' ||
    value > MAXIMUM_COST_MINOR ||
    (allowZero ? value < 0n : value <= 0n)
  ) {
    throw new Error('CREDIT_AMOUNT_INVALID');
  }
}
