# Prediction Market Arbitrage Bot

Concept inspired by the YouTube video: "I Built a Polymarket + Kalshi Arbitrage Bot (7 Day Results)" by Alex Carter.

## Overview

This project implements a prediction market arbitrage bot that exploits price differences between **Polymarket** and **Kalshi** - two popular prediction markets where users can trade on event outcomes.

### How Arbitrage Works

Prediction markets often have slight price discrepancies for the same event across different platforms. The arbitrage strategy:

1. **Monitor** prices for the same event on both platforms
2. **Detect** when one platform prices an outcome differently than the other
3. **Buy** on the cheaper market (lower price = better value)
4. **Sell** on the more expensive market (higher price = better exit)
5. **Lock in** risk-free profit regardless of the actual outcome

### Mathematical Foundation

```
Profit = |Price1 - Price2| / min(Price1, Price2) × 100%

Example:
- Polymarket: YES token = 52.3¢
- Kalshi:     YES token = 51.1¢
- Action: Buy on Kalshi at 51.1¢, sell on Polymarket at 52.3¢
- Profit: (52.3 - 51.1) / 51.1 × 100% = 2.35%
- With $1,000 capital: $1000 × 2.35% = $23.50 profit
```

### Project Structure

```
arbitrage_bot.py    - Main bot with API integration framework
arbitrage_demo.py   - Simplified demo with simulated prices
README.md           - This file
```

### Key Components

1. **PredictionMarketAPI** - Abstract base class for market integrations
2. **PolymarketAPI** - Polymarket platform integration (0-100 percentage format)
3. **KalshiAPI** - Kalshi platform integration (0-100 percentage format)
4. **ArbitrageDetector** - Finds price discrepancies between markets
5. **ArbitrageBot** - Executes the monitoring and trading loop
6. **ArbitrageDemo** - Simplified demonstration with mock data

### How to Run

```bash
# Install dependencies (none required for this pure Python script)
python arbitrage_demo.py
```

The demo will:
- Monitor sample events for arbitrage opportunities
- Display any detected spreads with profit percentages
- Show buy/sell platforms and recommended actions

### Important Notes

⚠️ **Educational Purpose**: This code is for educational and demonstration purposes only.

⚠️ **Real Trading Risks**: Actual prediction market arbitrage involves:
- Transaction fees on both platforms
- Withdrawal/deposit delays
- Order execution slippage
- Minimum trade sizes
- Platform-specific restrictions
- Potential for price changes between order placement and execution

⚠️ **API Keys Required**: To trade with real funds, you'll need:
- Polymarket API key (for clobder API)
- Kalshi API key and secret (for their REST API)

⚠️ **Market Hours**: Prediction markets may have different trading hours and settlement times.

### Potential Improvements

- Real-time WebSocket price feeds
- Order book depth analysis
- Multiple event filtering
- Risk management position sizing
- Historical performance tracking
- Multi-market arbitrage (more than 2 platforms)
- Automated trade execution with proper signing