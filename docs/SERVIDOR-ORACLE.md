# Servidor RiddimX na Oracle Cloud (grátis)

Este servidor entra em ação quando a internet de casa não deixa o link direto funcionar (double NAT ou CGNAT). Ele roda numa máquina grátis da Oracle (Always Free), com até 10 TB de tráfego por mês. Leva uns 30 minutos.

## 1. Criar a conta Oracle

1. Acesse **oracle.com/cloud/free** e clique em **Start for free**.
2. **Cartão:** a Oracle pede um cartão de crédito só para verificar a conta. Pode aparecer uma cobrança temporária de cerca de US$ 1, que é estornada. Enquanto você **não** clicar em "Upgrade to Pay As You Go", nada é cobrado.
3. **Home Region:** escolha com cuidado, porque **ela não muda depois**. As máquinas ARM grátis (Ampere A1) às vezes esgotam ("Out of capacity") em regiões cheias.
   - Para o Brasil, tente **Brazil East (São Paulo)** ou **Brazil Southeast (Vinhedo)**.
   - Se as duas estiverem sempre esgotadas, uma região menos disputada (Chile, por exemplo) costuma ter vaga. O atraso aumenta um pouco.

## 2. Criar a máquina

1. No painel, vá em **Compute › Instances › Create instance**.
2. Em **Image**, escolha **Ubuntu 22.04** (ou 24.04). Em **Shape**, clique em **Change shape**, depois **Ampere**, e escolha **VM.Standard.A1.Flex** com **1 OCPU e 6 GB**. Isso já sobra; o limite grátis é 4 OCPU e 24 GB.
3. Em **Networking**, deixe criar a VCN nova e marque **Assign a public IPv4 address**.
4. Em **SSH keys**, clique em **Save private key** e guarde o arquivo `.key`.
5. Clique em **Create**.
   - Se aparecer **"Out of capacity"**, tente de novo mais tarde ou mude o **Availability Domain** (AD-1, AD-2…). É comum precisar de algumas tentativas.
6. **Fixe o IP:** em **Networking › Reserved Public IPs**, reserve um IP (é grátis) e troque o IP da máquina por ele. Assim o link do app nunca muda.

## 3. Abrir as portas (em DOIS lugares)

**Lugar 1, no painel da Oracle:** vá em **Networking › Virtual Cloud Networks**, abra a sua VCN e depois **Security Lists › Default Security List › Add Ingress Rules**. Crie uma regra para cada linha, todas com **Source CIDR** `0.0.0.0/0`:

| Protocolo | Porta |
|---|---|
| TCP | 80 |
| TCP | 443 |
| TCP | 7881 |
| UDP | 3478 |
| UDP | 50000-50200 |

**Lugar 2, dentro da máquina:** o Ubuntu da Oracle vem com um firewall próprio que bloqueia tudo. O script do passo 4 abre essas portas sozinho; é só responder **Y** quando ele perguntar.

## 4. Instalar o servidor

1. No Mac, abra o Terminal e conecte na máquina. Troque o caminho do arquivo e o IP pelos seus:

   ```bash
   chmod 600 ~/Downloads/ssh-key.key && ssh -i ~/Downloads/ssh-key.key ubuntu@SEU-IP
   ```

2. Já dentro da máquina, instale o Docker:

   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   ```

3. Copie a pasta `server/` do projeto para a máquina. Rode isto no **Mac**, em outra aba do Terminal:

   ```bash
   scp -i ~/Downloads/ssh-key.key -r ~/Desktop/github/riddimx/server ubuntu@SEU-IP:~/
   ```

4. Na máquina, rode a instalação:

   ```bash
   cd ~/server && ./install.sh
   ```

   - Quando ele pedir o **Public IP**, cole o IP da máquina, que aparece na página da instância.
   - Quando ele pedir o **domínio**, só aperte Enter. Ele usa `SEU-IP.sslip.io`, que é grátis e não precisa comprar domínio.
   - Quando ele perguntar se abre as portas, responda **Y**.
   - No final ele mostra **duas linhas**: `VITE_RELAY_URL=…` e `VITE_RELAY_KEY=…`. **Guarde as duas.**

5. Ligue o servidor:

   ```bash
   sudo docker compose up -d
   ```

6. Teste: abra `https://SEU-IP-COM-TRACOS.sslip.io/health` no navegador. Deve aparecer `{"ok":true…}`. O certificado pode levar até 1 minuto na primeira vez.

## 5. Ligar o app ao servidor

- **Para testar agora**, sem gerar o app de novo: no RiddimX, dê **GO LIVE**, clique em **LIVE** e preencha **SERVER** com a URL e a chave do passo 4. Depois clique em **SAVE**.
- **Para todos os usuários**, gere o app com o servidor embutido. Assim ninguém precisa configurar nada:

  ```bash
  VITE_RELAY_URL=https://SEU-IP-COM-TRACOS.sslip.io VITE_RELAY_KEY=SUA-CHAVE npm run package
  ```

## Se der problema

- **O `/health` não abre:** falta abrir a porta 443 num dos dois lugares do passo 3, ou o Docker não subiu. Para ver o que aconteceu, rode `sudo docker compose logs caddy`.
- **Conecta, mas sem som:** faltam as portas UDP `50000-50200` ou a TCP `7881` na Security List da Oracle.
- **A Oracle desligou a máquina:** às vezes a Oracle recupera máquinas grátis paradas. Com ouvintes de verdade isso não acontece; se acontecer, é só ligar de novo em **Instances › Start**.
