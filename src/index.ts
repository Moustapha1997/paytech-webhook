import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import webhookRoutes from './routes/webhook';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log middleware
app.use((req, res, next) => {
    console.log('=== REQUEST RECEIVED ===');
    console.log('Method:', req.method);
    console.log('Path:', req.path);
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    next();
});

// Routes
app.use('/', webhookRoutes);

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});