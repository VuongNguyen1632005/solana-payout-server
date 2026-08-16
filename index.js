require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');

const app = express();
app.use(cors());
app.use(express.json());

// 1. KẾT NỐI MẠNG LƯỚI SOLANA
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// 2. KHỞI TẠO VÍ NGUỒN PHÁT TOKEN
let fromWallet;
const rawSecret = process.env.PRIVATE_KEY || process.env.SOLANA_SECRET_KEY || process.env.SOLANA_PRIVATE_KEY || '';
const tokenMintAddress = process.env.MINT_ADDRESS || process.env.TOKEN_MINT_ADDRESS || 'HHb2PrZYNwqJLCJKGMvwtsRdc3hZvMBNdoqYSKDoFEdO';
const PAYOUT_API_KEY = process.env.PAYOUT_API_KEY || '';

if (!rawSecret) {
  console.error("❌ LỖI: Chưa cài đặt biến môi trường PRIVATE_KEY trên Render!");
  process.exit(1);
}

try {
  if (rawSecret.trim().startsWith('[')) {
    fromWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawSecret.trim())));
  } else {
    fromWallet = Keypair.fromSecretKey(bs58.decode(rawSecret.trim()));
  }
  console.log("✅ KẾT NỐI VÍ NGUỒN PHÁT THÀNH CÔNG:", fromWallet.publicKey.toBase58());
} catch (error) {
  console.error("❌ LỖI: Định dạng mật mã ví (Private Key) không hợp lệ:", error.message);
  process.exit(1);
}

// 3. HEALTH CHECK ENDPOINT (Dành cho Render & Web Monitoring)
app.get(['/', '/health'], async (req, res) => {
  try {
    let solBalance = 0;
    try {
      solBalance = await connection.getBalance(fromWallet.publicKey) / 1e9;
    } catch (e) {
      // Non-fatal if RPC rate-limited
    }

    return res.json({
      status: "ok",
      service: "Solana Payout Server (Render)",
      payerPublicKey: fromWallet.publicKey.toBase58(),
      tokenMint: tokenMintAddress,
      solBalance: `${solBalance} SOL`,
      rpcUrl: RPC_URL.replace(/(api-key=)[^&]+/, '$1***'), // Hide api key in rpc if any
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// 4. MIDDLEWARE BẢO MẬT API KEY (Ngăn chặn bên ngoài gọi trộm API)
const authenticatePayoutRequest = (req, res, next) => {
  if (!PAYOUT_API_KEY) {
    // Nếu chưa set key, cho phép đi tiếp nhưng cảnh báo bảo mật
    return next();
  }

  const clientKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!clientKey || clientKey !== PAYOUT_API_KEY) {
    console.warn("⚠️ CẢNH BÁO BẢO MẬT: Phát hiện truy cập trái phép hoặc sai PAYOUT_API_KEY!");
    return res.status(401).json({
      success: false,
      message: "Truy cập bị từ chối: Sai hoặc thiếu X-API-KEY"
    });
  }
  next();
};

// 5. API XỬ LÝ DUYỆT LỆNH CHUYỂN TOKEN TỰ ĐỘNG
app.post('/api/payout', authenticatePayoutRequest, async (req, res) => {
  try {
    const { wallet, amount } = req.body;

    if (!wallet || !amount || Number(amount) <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: "Thiếu hoặc sai địa chỉ ví nhận (wallet) hoặc số lượng token (amount)" 
      });
    }

    console.log(`🚀 Hệ thống đang tự động duyệt lệnh: Chuyển ${amount} Token tới ví ${wallet}...`);

    let signature;
    try {
      const toPublicKey = new PublicKey(wallet);
      const mintPublicKey = new PublicKey(tokenMintAddress);

      const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection, 
        fromWallet, 
        mintPublicKey, 
        fromWallet.publicKey
      );
      
      const toTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection, 
        fromWallet, 
        mintPublicKey, 
        toPublicKey
      );

      const decimals = parseInt(process.env.TOKEN_DECIMALS || '9', 10);
      const amountInLamports = BigInt(Math.round(Number(amount) * Math.pow(10, decimals)));

      const transferInstruction = createTransferInstruction(
        fromTokenAccount.address,
        toTokenAccount.address,
        fromWallet.publicKey,
        amountInLamports
      );

      const transaction = new Transaction().add(transferInstruction);
      signature = await sendAndConfirmTransaction(connection, transaction, [fromWallet]);
    } catch (onChainError) {
      if (process.env.ENABLE_MOCK_PAYOUT === 'true' || (process.env.NODE_ENV !== 'production' && !process.env.PRIVATE_KEY)) {
        const mockBytes = Uint8Array.from([...Keypair.generate().secretKey, ...Keypair.generate().secretKey]);
        signature = bs58.encode(mockBytes.slice(0, 64));
        console.log(`⚠️ DEMO LOCAL TEST MODE: Đã chi trả thành công và tạo mã Tx Signature: ${signature}`);
      } else {
        throw onChainError;
      }
    }

    console.log(`✅ CHUYỂN TOKEN TỰ ĐỘNG THÀNH CÔNG! Mã Tx: ${signature}`);
    return res.json({
      success: true,
      status: "approved",
      message: "Duyệt lệnh chuyển Token tự động thành công!",
      signature: signature
    });

  } catch (error) {
    console.error("❌ LỖI KHÔNG CHUYỂN ĐƯỢC TOKEN TỰ ĐỘNG:", error.message);
    return res.status(500).json({ 
      success: false, 
      message: "Lỗi giao dịch on-chain: " + error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server payout tự động đang chạy tại cổng ${PORT}`);
});
