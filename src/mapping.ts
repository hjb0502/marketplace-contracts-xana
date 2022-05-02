import { BigInt, log } from "@graphprotocol/graph-ts";
import {
  GovernorAlpha,
  ProposalCanceled,
  ProposalCreated,
  ProposalExecuted,
  ProposalQueued,
  VoteCast
} from "../generated/GovernorAlpha/GovernorAlpha";
import {
  DelegateChanged,
  DelegateVotesChanged,
  Transfer
} from "../generated/ZoraclesToken/ZoraclesToken";
import {
  getOrCreateTokenHolder,
  getOrCreateDelegate,
  getOrCreateProposal,
  getOrCreateVote,
  getGovernanceEntity
} from "./utils/helpers";
import {
  ZERO_ADDRESS,
  BIGINT_ONE,
  BIGINT_ZERO,
  STATUS_ACTIVE,
  STATUS_QUEUED,
  STATUS_PENDING,
  STATUS_EXECUTED,
  STATUS_CANCELLED
} from "./utils/constants";
import { toDecimal } from "./utils/decimals";

export function handleProposalCanceled(event: ProposalCanceled): void {
  let proposal = getOrCreateProposal(event.params.id.toString());

  proposal.status = STATUS_CANCELLED;
  proposal.save();
}

export function handleProposalCreated(event: ProposalCreated): void {
  let proposal = getOrCreateProposal(event.params.id.toString());
    // let proposer = getOrCreateDelegate(
    //     event.params.proposer.toHexString(),
    //     false
    // );

    // checking if the proposer was a delegate already accounted for, if not we should log an error
    // since it shouldn't be possible for a delegate to propose anything without first being "created"
    // if (proposer == null) {
    //     log.error("Delegate {} not found on ProposalCreated. tx_hash: {}", [
    //         event.params.proposer.toHexString(),
    //         event.transaction.hash.toHexString()
    //     ]);
    // }

    // Creating it anyway since we will want to account for this event data, even though it should've never happened
    let proposer = getOrCreateDelegate(event.params.proposer.toHexString());

    proposal.proposer = proposer.id;
  let targets: string[] = [];
  for(var i = 0; i < event.params.targets.length; i ++) {
    targets.push(event.params.targets[i].toHexString());
  }
  proposal.targets = targets;
  proposal.values = event.params.values;
  proposal.signatures = event.params.signatures;
  proposal.calldatas = event.params.calldatas;
  proposal.startBlock = event.params.startBlock;
  proposal.endBlock = event.params.endBlock;
  proposal.description = event.params.description;
  proposal.status = event.block.number >= proposal.startBlock ? STATUS_ACTIVE : STATUS_PENDING;
  proposal.save();
}

export function handleProposalExecuted(event: ProposalExecuted): void {
  let governance = getGovernanceEntity();
  let proposal = getOrCreateProposal(event.params.id.toString());

  proposal.status = STATUS_EXECUTED;
  proposal.executionETA = null;
  proposal.save();

  governance.proposalsQueued = governance.proposalsQueued - BIGINT_ONE;
  governance.save();
}

export function handleProposalQueued(event: ProposalQueued): void {
  let governance = getGovernanceEntity();
  let proposal = getOrCreateProposal(event.params.id.toString());

  proposal.status = STATUS_QUEUED;
  proposal.executionETA = event.params.eta;
  proposal.save();

  governance.proposalsQueued = governance.proposalsQueued + BIGINT_ONE;
  governance.save();
}

export function handleVoteCast(event: VoteCast): void {
  let proposal = getOrCreateProposal(event.params.proposalId.toString());
  let voteId = event.params.voter
      .toHexString()
      .concat("-")
      .concat(event.params.proposalId.toString());
  let vote = getOrCreateVote(voteId);
  let voter = getOrCreateDelegate(event.params.voter.toHexString(), false);

  // checking if the voter was a delegate already accounted for, if not we should log an error
  // since it shouldn't be possible for a delegate to vote without first being "created"
  if (voter == null) {
      log.error("Delegate {} not found on VoteCast. tx_hash: {}", [
          event.params.voter.toHexString(),
          event.transaction.hash.toHexString()
      ]);
  }

  // Creating it anyway since we will want to account for this event data, even though it should've never happened
  voter = getOrCreateDelegate(event.params.voter.toHexString());

  vote.proposal = proposal.id;
  vote.voter = voter.id;
  vote.votesRaw = event.params.votes;
  vote.votes = toDecimal(event.params.votes);
  vote.support = event.params.support;

  vote.save();

  if (proposal.status == STATUS_PENDING) {
      proposal.status = STATUS_ACTIVE;
      proposal.save();
  }
}

export function handleDelegateChanged(event: DelegateChanged): void {
  let tokenHolder = getOrCreateTokenHolder(
      event.params.delegator.toHexString()
  );
  let previousDelegate = getOrCreateDelegate(
      event.params.fromDelegate.toHexString()
  );
  let newDelegate = getOrCreateDelegate(event.params.toDelegate.toHexString());

  tokenHolder.delegate = newDelegate.id;
  tokenHolder.save();

  previousDelegate.tokenHoldersRepresentedAmount =
      previousDelegate.tokenHoldersRepresentedAmount - 1;
  newDelegate.tokenHoldersRepresentedAmount =
      newDelegate.tokenHoldersRepresentedAmount + 1;
  previousDelegate.save();
  newDelegate.save();
}
export function handleDelegateVotesChanged(event: DelegateVotesChanged): void {
  let governance = getGovernanceEntity();
  let delegate = getOrCreateDelegate(event.params.delegate.toHexString());
  let votesDifference = event.params.newBalance - event.params.previousBalance;

  delegate.delegatedVotesRaw = event.params.newBalance;
  delegate.delegatedVotes = toDecimal(event.params.newBalance);
  delegate.save();

  if (
      event.params.previousBalance == BIGINT_ZERO &&
      event.params.newBalance > BIGINT_ZERO
  ) {
      governance.currentDelegates = governance.currentDelegates + BIGINT_ONE;
  }
  if (event.params.newBalance == BIGINT_ZERO) {
      governance.currentDelegates = governance.currentDelegates - BIGINT_ONE;
  }
  governance.delegatedVotesRaw = governance.delegatedVotesRaw + votesDifference;
  governance.delegatedVotes = toDecimal(governance.delegatedVotesRaw);
  governance.save();
}
export function handleTransfer(event: Transfer): void {
  let fromHolder = getOrCreateTokenHolder(event.params.from.toHexString());
  let toHolder = getOrCreateTokenHolder(event.params.to.toHexString());
  let governance = getGovernanceEntity();

  // fromHolder
  if (event.params.from.toHexString() != ZERO_ADDRESS) {
      let fromHolderPreviousBalance = fromHolder.tokenBalanceRaw;
      fromHolder.tokenBalanceRaw =
          fromHolder.tokenBalanceRaw - event.params.value;
      fromHolder.tokenBalance = toDecimal(fromHolder.tokenBalanceRaw);

      if (fromHolder.tokenBalanceRaw < BIGINT_ZERO) {
          log.error("Negative balance on holder {} with balance {}", [
              fromHolder.id,
              fromHolder.tokenBalanceRaw.toString()
          ]);
      }

      if (
          fromHolder.tokenBalanceRaw == BIGINT_ZERO &&
          fromHolderPreviousBalance > BIGINT_ZERO
      ) {
          governance.currentTokenHolders =
              governance.currentTokenHolders - BIGINT_ONE;
          governance.save();
      } else if (
          fromHolder.tokenBalanceRaw > BIGINT_ZERO &&
          fromHolderPreviousBalance == BIGINT_ZERO
      ) {
          governance.currentTokenHolders =
              governance.currentTokenHolders + BIGINT_ONE;
          governance.save();
      }

      fromHolder.save();
  }

  // toHolder
  let toHolderPreviousBalance = toHolder.tokenBalanceRaw;
  toHolder.tokenBalanceRaw = toHolder.tokenBalanceRaw + event.params.value;
  toHolder.tokenBalance = toDecimal(toHolder.tokenBalanceRaw);
  toHolder.totalTokensHeldRaw = toHolder.totalTokensHeldRaw + event.params.value;
  toHolder.totalTokensHeld = toDecimal(toHolder.totalTokensHeldRaw);

  if (
      toHolder.tokenBalanceRaw == BIGINT_ZERO &&
      toHolderPreviousBalance > BIGINT_ZERO
  ) {
      governance.currentTokenHolders =
          governance.currentTokenHolders - BIGINT_ONE;
      governance.save();
  } else if (
      toHolder.tokenBalanceRaw > BIGINT_ZERO &&
      toHolderPreviousBalance == BIGINT_ZERO
  ) {
      governance.currentTokenHolders =
          governance.currentTokenHolders + BIGINT_ONE;
      governance.save();
  }

  toHolder.save();
}
