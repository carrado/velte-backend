// src/controllers/aiSetup.controller.js
import AISetup from "../../models/AiSetup.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import {
  exchangeSDKToken,
  fetchWABAPhoneNumbers,
  subscribeToWebhook,
} from "../../services/meta.service.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrCreateSetup(userId) {
  let setup = await AISetup.findOne({ userId });
  if (!setup) {
    setup = await AISetup.create({ userId });
  }
  return setup;
}

function formatSetup(setup) {
  return {
    isComplete: setup.isComplete,
    metaConnected: setup.metaConnected,
    wabaConfigured: setup.wabaConfigured,
    selectedNumberId: setup.selectedNumberId,
    selectedNumber: setup.selectedNumber,
    aiConfig: setup.aiConfig,
  };
}

// ── GET /ai-setup/status ──────────────────────────────────────────────────────

export async function getStatus(req, res, next) {
  try {
    const setup = await getOrCreateSetup(req.user.userId);
    res.json({ success: true, data: formatSetup(setup) });
  } catch (err) {
    next(err);
  }
}


// ── POST /ai-setup/waba/configure ─────────────────────────────────────────────

export async function configureWABA(req, res, next) {
  try {
    const { accessToken:sdkToken } = req.body;

    if (!sdkToken) {
      throw new AppError("Access Token is required.", 400);
    }

    // 1. Exchange token for longer Meta access token

    const { accessToken, expiresIn } = await exchangeSDKToken(sdkToken);

    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // 2. Get user's Meta businesses
    const businessesResponse = await fetch(
      "https://graph.facebook.com/v20.0/me/businesses",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    const businessesRes = await businessesResponse.json();

    if (!businessesResponse.ok) {
      throw new AppError(
        businessesRes?.error?.message || "Failed to fetch Meta businesses.",
        400,
      );
    }

    const businesses = businessesRes?.data ?? [];

    if (!businesses.length) {
      throw new AppError("No Meta Business account found.", 404);
    }

    // 3. Get WABAs from all businesses
    const availableWABAs = [];

    for (const business of businesses) {
      const wabaResponse = await fetch(
        `https://graph.facebook.com/v20.0/${business.id}/owned_whatsapp_business_accounts`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      const wabaRes = await wabaResponse.json();

      if (!wabaResponse.ok) {
        continue;
      }

      const wabas = wabaRes?.data ?? [];

      for (const waba of wabas) {
        availableWABAs.push({
          id: waba.id,
          name: waba.name,
          businessId: business.id,
          businessName: business.name,
        });
      }
    }

    if (!availableWABAs.length) {
      throw new AppError("No WhatsApp Business Account found.", 404);
    }

    // 4. Fetch phone numbers for each WABA
    const availableNumbers = [];

    for (const waba of availableWABAs) {
      const numbersResponse = await fetch(
        `https://graph.facebook.com/v20.0/${waba.id}/phone_numbers`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      const numbersRes = await numbersResponse.json();

      if (!numbersResponse.ok) {
        continue;
      }

      const numbers = numbersRes?.data ?? [];

      for (const number of numbers) {
        availableNumbers.push({
          id: number.id,
          displayPhoneNumber: number.display_phone_number,
          verifiedName: number.verified_name,
          qualityRating: number.quality_rating,
          platformType: number.platform_type,
          wabaId: waba.id,
          wabaName: waba.name,
          businessId: waba.businessId,
          businessName: waba.businessName,
        });
      }
    }

    if (!availableNumbers.length) {
      throw new AppError(
        "No WhatsApp phone number found under this account.",
        404,
      );
    }

    // 5. Save setup
    const selectedWABA = availableWABAs[0];

    await AISetup.findOneAndUpdate(
      { userId: req.user.userId },
      {
        $set: {
          metaConnected: true,
          metaAccessToken: accessToken,
          metaAccessTokenExpiresAt: expiresAt, 
          availableWABAs,
          availableNumbers,
          wabaConfigured: availableWABAs.length === 1,
          wabaId: selectedWABA.id,
        },
      },
      {
        upsert: true,
        new: true,
      },
    );

    res.json({
      success: true,
      data: {
        metaConnected: true,
        availableWABAs,
        availableNumbers,
        selectedWABA,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /ai-setup/numbers ─────────────────────────────────────────────────────

export async function getNumbers(req, res, next) {
  try {
    const setup = await AISetup.findOne({ userId: req.user.userId }).select(
      "+metaAccessToken",
    );
    if (!setup) throw new AppError("AI setup not initialised.", 400);
    if (!setup.wabaConfigured)
      throw new AppError(
        "WABA must be configured before fetching numbers.",
        400,
      );

    const numbers = await fetchWABAPhoneNumbers(
      setup.wabaId,
      setup.metaAccessToken,
    );

    await AISetup.findOneAndUpdate(
      { userId: req.user.userId },
      { $set: { availableNumbers: numbers } },
    );

    res.json({ success: true, data: { numbers } });
  } catch (err) {
    next(err);
  }
}

// ── POST /ai-setup/numbers/select ─────────────────────────────────────────────

export async function selectNumber(req, res, next) {
  try {
    const { numberId } = req.body;

    const setup = await AISetup.findOne({ userId: req.user.userId });
    if (!setup) throw new AppError("AI setup not initialised.", 400);

    const numberExists = setup.availableNumbers.some(
      (n) => n.numberId === numberId,
    );
    if (!numberExists) {
      throw new AppError(
        "The selected number does not belong to your WhatsApp Business Account.",
        403,
      );
    }

    await AISetup.findOneAndUpdate(
      { userId: req.user.userId },
      { $set: { selectedNumberId: numberId } },
    );

    res.json({ success: true, data: { selectedNumberId: numberId } });
  } catch (err) {
    next(err);
  }
}

// ── PUT /ai-setup/config ──────────────────────────────────────────────────────

export async function updateConfig(req, res, next) {
  try {
    const { enabled, greetingMessage, businessTone, productCatalogSync } =
      req.body;

    const setup = await AISetup.findOneAndUpdate(
      { userId: req.user.userId },
      {
        $set: {
          "aiConfig.enabled": enabled,
          "aiConfig.greetingMessage": greetingMessage,
          "aiConfig.businessTone": businessTone,
          "aiConfig.productCatalogSync": productCatalogSync,
        },
      },
      { new: true, upsert: true, runValidators: true },
    );

    res.json({ success: true, data: { config: setup.aiConfig } });
  } catch (err) {
    next(err);
  }
}

// ── POST /ai-setup/activate ───────────────────────────────────────────────────

export async function activateAI(req, res, next) {
  try {
    const setup = await AISetup.findOne({ userId: req.user.userId }).select(
      "+metaAccessToken",
    );
    if (!setup) throw new AppError("AI setup not initialised.", 400);
    if (!setup.metaConnected)
      throw new AppError("Meta account must be connected.", 400);
    if (!setup.wabaConfigured)
      throw new AppError("WABA must be configured.", 400);
    if (!setup.selectedNumberId)
      throw new AppError("A WhatsApp number must be selected.", 400);

    const resData = await subscribeToWebhook(
      setup.wabaId,
      setup.metaAccessToken,
    );

    if (resData.success) {
      await AISetup.findOneAndUpdate(
        { userId: req.user.userId },
        { $set: { isComplete: true, activatedAt: new Date() } },
      );

      res.json({
        success: true,
        data: { activatedAt: new Date().toISOString() },
      });
    }
  } catch (err) {
    next(err);
  }
}

// ── DELETE /ai-setup/disconnect ───────────────────────────────────────────────

export async function disconnectAI(req, res, next) {
  try {
    await AISetup.findOneAndUpdate(
      { userId: req.user.userId },
      {
        $set: {
          metaConnected: false,
          metaAccessToken: null,
          metaAccessTokenExpiresAt: null,
          aiConfig: {
            greeting: 'Hello! 👋 Welcome to our store. How can I help you today?',
            businessTone: 'professional',
            productCatalogSync: true
          },
          metaUserId: null,
          wabaConfigured: false,
          wabaId: null,
          availableNumbers: [],
          selectedNumberId: null,
          isComplete: false,
          webhookUrl: null,
          webhookSecret: null,
          activatedAt: null,
        },
      },
    );

    res.json({
      success: true,
      message: "WhatsApp AI integration disconnected successfully.",
    });
  } catch (err) {
    next(err);
  }
}