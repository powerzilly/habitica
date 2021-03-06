import stripeModule from 'stripe';
import nconf from 'nconf';
import cc from 'coupon-code';

import {
  BadRequest,
  NotAuthorized,
  NotFound,
} from './errors';
import payments from './payments';
import { model as User } from '../models/user';
import { model as Coupon } from '../models/coupon';
import {
  model as Group,
  basicFields as basicGroupFields,
} from '../models/group';
import shared from '../../common';

let stripe = stripeModule(nconf.get('STRIPE_API_KEY'));
const i18n = shared.i18n;

let api = {};

api.constants = {
  // CURRENCY_CODE: 'USD',
  // SELLER_NOTE: 'Habitica Payment',
  // SELLER_NOTE_SUBSCRIPTION: 'Habitica Subscription',
  // SELLER_NOTE_ATHORIZATION_SUBSCRIPTION: 'Habitica Subscription Payment',
  // STORE_NAME: 'Habitica',
  //
  // GIFT_TYPE_GEMS: 'gems',
  // GIFT_TYPE_SUBSCRIPTION: 'subscription',
  //
  // METHOD_BUY_GEMS: 'buyGems',
  // METHOD_CREATE_SUBSCRIPTION: 'createSubscription',
  PAYMENT_METHOD: 'Stripe',
  // PAYMENT_METHOD_GIFT: 'Amazon Payments (Gift)',
};

api.setStripeApi = function setStripeApi (stripeInc) {
  stripe = stripeInc;
};


/**
 * Allows for purchasing a user subscription, group subscription or gems with Stripe
 *
 * @param  options
 * @param  options.token  The stripe token generated on the front end
 * @param  options.user  The user object who is purchasing
 * @param  options.gift  The gift details if any
 * @param  options.sub  The subscription data to purchase
 * @param  options.groupId  The id of the group purchasing a subscription
 * @param  options.email  The email enter by the user on the Stripe form
 * @param  options.headers  The request headers to store on analytics
 * @return undefined
 */
api.checkout = async function checkout (options, stripeInc) {
  let {
    token,
    user,
    gift,
    sub,
    groupId,
    email,
    headers,
    coupon,
  } = options;
  let response;
  let subscriptionId;

  // @TODO: We need to mock this, but curently we don't have correct Dependency Injection. And the Stripe Api doesn't seem to be a singleton?
  let stripeApi = stripe;
  if (stripeInc) stripeApi = stripeInc;

  if (!token) throw new BadRequest('Missing req.body.id');

  if (sub) {
    if (sub.discount) {
      if (!coupon) throw new BadRequest(shared.i18n.t('couponCodeRequired'));
      coupon = await Coupon.findOne({_id: cc.validate(coupon), event: sub.key}).exec();
      if (!coupon) throw new BadRequest(shared.i18n.t('invalidCoupon'));
    }

    let customerObject = {
      email,
      metadata: { uuid: user._id },
      card: token,
      plan: sub.key,
    };

    if (groupId) {
      customerObject.quantity = sub.quantity;
    }

    response = await stripeApi.customers.create(customerObject);

    if (groupId) subscriptionId = response.subscriptions.data[0].id;
  } else {
    let amount = 500; // $5

    if (gift) {
      if (gift.type === 'subscription') {
        amount = `${shared.content.subscriptionBlocks[gift.subscription.key].price * 100}`;
      } else {
        amount = `${gift.gems.amount / 4 * 100}`;
      }
    }

    response = await stripeApi.charges.create({
      amount,
      currency: 'usd',
      card: token,
    });
  }

  if (sub) {
    await payments.createSubscription({
      user,
      customerId: response.id,
      paymentMethod: this.constants.PAYMENT_METHOD,
      sub,
      headers,
      groupId,
      subscriptionId,
    });
  } else {
    let method = 'buyGems';
    let data = {
      user,
      customerId: response.id,
      paymentMethod: this.constants.PAYMENT_METHOD,
      gift,
    };

    if (gift) {
      let member = await User.findById(gift.uuid).exec();
      gift.member = member;
      if (gift.type === 'subscription') method = 'createSubscription';
      data.paymentMethod = 'Gift';
    }

    await payments[method](data);
  }
};

/**
 * Edits a subscription created by Stripe
 *
 * @param  options
 * @param  options.token  The stripe token generated on the front end
 * @param  options.user  The user object who is purchasing
 * @param  options.groupId  The id of the group purchasing a subscription
 *
 * @return undefined
 */
api.editSubscription = async function editSubscription (options, stripeInc) {
  let {token, groupId, user} = options;
  let customerId;

  // @TODO: We need to mock this, but curently we don't have correct Dependency Injection. And the Stripe Api doesn't seem to be a singleton?
  let stripeApi = stripe;
  if (stripeInc) stripeApi = stripeInc;

  if (groupId) {
    let groupFields = basicGroupFields.concat(' purchased');
    let group = await Group.getGroup({user, groupId, populateLeader: false, groupFields});

    if (!group) {
      throw new NotFound(i18n.t('groupNotFound'));
    }

    let allowedManagers = [group.leader, group.purchased.plan.owner];

    if (allowedManagers.indexOf(user._id) === -1) {
      throw new NotAuthorized(i18n.t('onlyGroupLeaderCanManageSubscription'));
    }
    customerId = group.purchased.plan.customerId;
  } else {
    customerId = user.purchased.plan.customerId;
  }

  if (!customerId) throw new NotAuthorized(i18n.t('missingSubscription'));
  if (!token) throw new BadRequest('Missing req.body.id');

  let subscriptions = await stripeApi.customers.listSubscriptions(customerId); // @TODO: Handle Stripe Error response
  let subscriptionId = subscriptions.data[0].id;
  await stripeApi.customers.updateSubscription(customerId, subscriptionId, { card: token });
};

/**
 * Cancels a subscription created by Stripe
 *
 * @param  options
 * @param  options.user  The user object who is purchasing
 * @param  options.groupId  The id of the group purchasing a subscription
 *
 * @return undefined
 */
api.cancelSubscription = async function cancelSubscription (options, stripeInc) {
  let {groupId, user} = options;
  let customerId;

  // @TODO: We need to mock this, but curently we don't have correct Dependency Injection. And the Stripe Api doesn't seem to be a singleton?
  let stripeApi = stripe;
  if (stripeInc) stripeApi = stripeInc;

  if (groupId) {
    let groupFields = basicGroupFields.concat(' purchased');
    let group = await Group.getGroup({user, groupId, populateLeader: false, groupFields});

    if (!group) {
      throw new NotFound(i18n.t('groupNotFound'));
    }

    let allowedManagers = [group.leader, group.purchased.plan.owner];

    if (allowedManagers.indexOf(user._id) === -1) {
      throw new NotAuthorized(i18n.t('onlyGroupLeaderCanManageSubscription'));
    }
    customerId = group.purchased.plan.customerId;
  } else {
    customerId = user.purchased.plan.customerId;
  }

  if (!customerId) throw new NotAuthorized(i18n.t('missingSubscription'));

  // @TODO: Handle error response
  let customer = await stripeApi.customers.retrieve(customerId);

  let subscription = customer.subscription;
  if (!subscription && customer.subscriptions) {
    subscription = customer.subscriptions.data[0];
  }

  if (!subscription) return;

  await stripeApi.customers.del(customerId);
  await payments.cancelSubscription({
    user,
    groupId,
    nextBill: subscription.current_period_end * 1000, // timestamp in seconds
    paymentMethod: this.constants.PAYMENT_METHOD,
  });
};

api.chargeForAdditionalGroupMember = async function chargeForAdditionalGroupMember (group) {
  let stripeApi = stripe;
  let plan = shared.content.subscriptionBlocks.group_monthly;

  await stripeApi.subscriptions.update(
    group.purchased.plan.subscriptionId,
    {
      plan: plan.key,
      quantity: group.memberCount + plan.quantity - 1,
    }
  );

  group.purchased.plan.quantity = group.memberCount + plan.quantity - 1;
};

module.exports = api;
