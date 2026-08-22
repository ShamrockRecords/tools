const INVITED_UNLIMITED_CLAIM = 'mojidasInvitedUnlimited';

function isInvitedUnlimited(user) {
  return Boolean(
    user
    && user.customClaims
    && user.customClaims[INVITED_UNLIMITED_CLAIM] === true
  );
}

module.exports = {
  INVITED_UNLIMITED_CLAIM,
  isInvitedUnlimited,
};
